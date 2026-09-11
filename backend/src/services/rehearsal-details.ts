/**
 * Rehearsal details + band profile + info-pack sending.
 *
 * See docs/REHEARSAL-INFO-AND-PROFILE-SPEC.md. Three concerns:
 *   - per-job lightweight intake (rehearsal_job_details)
 *   - persistent BAND profile (organisation_rehearsal_profile) — the "hotel book"
 *   - the client-facing info-pack email (boilerplate from system_settings +
 *     per-job merge), with band-level "last sent" tracking
 *
 * Anchor rule: the profile hangs off the BAND org (job_organisations.role='band'),
 * falling back to the job's client org. `resolveRehearsalAnchorOrg` is the one
 * place that decides "whose profile applies to this job".
 */
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { query } from '../config/database';
import { emailService } from './email-service';
import { getSystemSettings, invalidateSystemSettingsCache } from '../routes/system-settings';
import { getFromR2, uploadToPublicR2, deleteFromPublicR2 } from '../config/r2';
import { resolveClientEmailTarget, buildFallbackBanner, logFallbackToTimeline } from './money-emails';
import { getJobCoverage } from './studio-sitter';

// ── Info-pack photos (client email) ─────────────────────────────────────────
// Images live in the PUBLIC R2 bucket so the inline <img> URLs are durable
// (presigned links would expire in an archived client email). Stored as a JSON
// array on the `rehearsal_info_pack_images` system_settings row.
export interface InfoPackImage { key: string; filename: string; caption: string; url?: string }
const IMAGES_KEY = 'rehearsal_info_pack_images';
export const MAX_INFO_PACK_IMAGES = 6;

function publicUrl(key: string): string {
  const base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/${key}`;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function writeSystemSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO system_settings (key, value, category) VALUES ($1, $2, 'rehearsals')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
  invalidateSystemSettingsCache();
}

async function readImages(): Promise<InfoPackImage[]> {
  const s = await getSystemSettings([IMAGES_KEY]);
  try {
    const arr = JSON.parse(s[IMAGES_KEY] || '[]');
    return Array.isArray(arr) ? arr.filter((x: any) => x && x.key) : [];
  } catch {
    return [];
  }
}

export async function getInfoPackImages(): Promise<InfoPackImage[]> {
  return (await readImages()).map((im) => ({ ...im, caption: im.caption || '', url: publicUrl(im.key) }));
}

/** Copy an already-uploaded private object into the public bucket + register it. */
export async function addInfoPackImage(privateKey: string, filename: string, caption: string): Promise<InfoPackImage[]> {
  const images = await readImages();
  if (images.length >= MAX_INFO_PACK_IMAGES) throw new Error(`Maximum ${MAX_INFO_PACK_IMAGES} photos`);
  const obj = await getFromR2(privateKey);
  if (!obj.Body) throw new Error('Uploaded file not found');
  const buf = await streamToBuffer(obj.Body as Readable);
  const ext = (filename.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const publicKey = `rehearsal-info-pack/${randomUUID()}.${ext}`;
  await uploadToPublicR2(publicKey, buf, obj.ContentType || 'image/jpeg');
  images.push({ key: publicKey, filename, caption: caption || '' });
  await writeSystemSetting(IMAGES_KEY, JSON.stringify(images));
  return getInfoPackImages();
}

export async function updateInfoPackImageCaption(key: string, caption: string): Promise<InfoPackImage[]> {
  const images = await readImages();
  const im = images.find((x) => x.key === key);
  if (im) im.caption = caption || '';
  await writeSystemSetting(IMAGES_KEY, JSON.stringify(images));
  return getInfoPackImages();
}

export async function removeInfoPackImage(key: string): Promise<InfoPackImage[]> {
  const remaining = (await readImages()).filter((x) => x.key !== key);
  await writeSystemSetting(IMAGES_KEY, JSON.stringify(remaining));
  try { await deleteFromPublicR2(key); } catch { /* best-effort cleanup */ }
  return getInfoPackImages();
}

export interface RehearsalJobDetails {
  job_id: string;
  pa_setup: string | null;        // legacy — superseded by overrides.pa_monitoring
  backline_notes: string | null;  // legacy — superseded by overrides.usual_backline
  cars_count: number | null;
  dropoff_pickup: string | null;
  notes: string | null;
  // Per-hire overrides of band-standing profile fields, keyed by PROFILE field
  // name (room_setup, mic_list, power_notes, pa_monitoring, usual_backline, desk,
  // load_in_access, regular_contact). Display precedence: overrides[k] ?? profile[k].
  overrides: Record<string, string>;
  info_pack_sent_at: string | null;
  info_pack_sent_by: string | null;
}

export interface ProfileFile {
  r2_key: string;
  filename: string;
  content_type?: string | null;
  size_bytes?: number | null;
  label?: string | null;
  comment?: string | null;
  uploaded_at?: string;
  uploaded_by?: string | null;
}

export interface RehearsalProfile {
  organisation_id: string;
  room_setup: string | null;
  mic_list: string | null;
  power_notes: string | null;
  pa_monitoring: string | null;
  usual_backline: string | null;
  desk: string | null;
  load_in_access: string | null;
  regular_contact: string | null;
  preferences: { label: string; value: string }[];
  internal_notes: string | null;
  files: ProfileFile[];
}

export interface AnchorOrg {
  id: string;
  name: string | null;
}

/** Band-role org from job_organisations, else the job's client org. */
export async function resolveRehearsalAnchorOrg(jobId: string): Promise<AnchorOrg | null> {
  const band = await query(
    `SELECT o.id, o.name
     FROM job_organisations jo
     JOIN organisations o ON o.id = jo.organisation_id
     WHERE jo.job_id = $1 AND jo.role = 'band' AND o.is_deleted = false
     LIMIT 1`,
    [jobId]
  );
  if (band.rows[0]) return { id: band.rows[0].id, name: band.rows[0].name };

  const client = await query(
    `SELECT o.id, o.name
     FROM jobs j
     JOIN organisations o ON o.id = j.client_id AND o.is_deleted = false
     WHERE j.id = $1`,
    [jobId]
  );
  if (client.rows[0]) return { id: client.rows[0].id, name: client.rows[0].name };
  return null;
}

const JOB_DETAIL_COLS =
  'job_id, pa_setup, backline_notes, cars_count, dropoff_pickup, notes, overrides, info_pack_sent_at, info_pack_sent_by';

export async function getRehearsalJobDetails(jobId: string): Promise<RehearsalJobDetails | null> {
  const res = await query(
    `SELECT ${JOB_DETAIL_COLS} FROM rehearsal_job_details WHERE job_id = $1`,
    [jobId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, overrides: row.overrides ?? {} };
}

const JOB_DETAIL_FIELDS = ['pa_setup', 'backline_notes', 'cars_count', 'dropoff_pickup', 'notes'] as const;

export async function upsertRehearsalJobDetails(
  jobId: string,
  fields: Partial<Record<(typeof JOB_DETAIL_FIELDS)[number], string | number | null>> & {
    overrides?: Record<string, string>;
  }
): Promise<RehearsalJobDetails> {
  const insertCols: string[] = ['job_id'];
  const vals: any[] = [jobId];
  const setCols: string[] = [];
  for (const f of JOB_DETAIL_FIELDS) {
    if (f in fields) {
      insertCols.push(f);
      vals.push((fields as any)[f] ?? null);
      setCols.push(`${f} = EXCLUDED.${f}`);
    }
  }
  if ('overrides' in fields) {
    insertCols.push('overrides');
    vals.push(JSON.stringify(fields.overrides ?? {}));
    setCols.push('overrides = EXCLUDED.overrides');
  }
  const placeholders = insertCols.map((c, i) => (c === 'overrides' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const res = await query(
    `INSERT INTO rehearsal_job_details (${insertCols.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (job_id) DO UPDATE SET
       ${setCols.length ? setCols.join(', ') + ',' : ''} updated_at = NOW()
     RETURNING ${JOB_DETAIL_COLS}`,
    vals
  );
  return { ...res.rows[0], overrides: res.rows[0].overrides ?? {} };
}

const PROFILE_COLS =
  'organisation_id, room_setup, mic_list, power_notes, pa_monitoring, usual_backline, desk, load_in_access, regular_contact, preferences, internal_notes, files';

export async function getRehearsalProfile(orgId: string): Promise<RehearsalProfile | null> {
  const res = await query(
    `SELECT ${PROFILE_COLS} FROM organisation_rehearsal_profile WHERE organisation_id = $1`,
    [orgId]
  );
  return res.rows[0] ?? null;
}

const PROFILE_TEXT_FIELDS = [
  'room_setup', 'mic_list', 'power_notes', 'pa_monitoring', 'usual_backline',
  'desk', 'load_in_access', 'regular_contact', 'internal_notes',
] as const;

export async function upsertRehearsalProfile(
  orgId: string,
  fields: Partial<Record<(typeof PROFILE_TEXT_FIELDS)[number], string | null>> & {
    preferences?: { label: string; value: string }[];
  }
): Promise<RehearsalProfile> {
  const cols: string[] = [];
  const vals: any[] = [orgId];
  for (const f of PROFILE_TEXT_FIELDS) {
    if (f in fields) {
      cols.push(f);
      vals.push((fields as any)[f] ?? null);
    }
  }
  if (fields.preferences !== undefined) {
    cols.push('preferences');
    vals.push(JSON.stringify(fields.preferences ?? []));
  }
  const insertCols = ['organisation_id', ...cols];
  const placeholders = insertCols.map((_, i) => `$${i + 1}`);
  const updates = cols.map((c) => `${c} = EXCLUDED.${c}`);
  const res = await query(
    `INSERT INTO organisation_rehearsal_profile (${insertCols.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (organisation_id) DO UPDATE SET
       ${updates.length ? updates.join(', ') + ',' : ''} updated_at = NOW()
     RETURNING ${PROFILE_COLS}`,
    vals
  );
  return res.rows[0];
}

/** Append a desk file to the band profile (upserts the profile row if absent). */
export async function addProfileFile(orgId: string, file: ProfileFile): Promise<RehearsalProfile> {
  await query(
    `INSERT INTO organisation_rehearsal_profile (organisation_id, files)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (organisation_id) DO UPDATE SET
       files = COALESCE(organisation_rehearsal_profile.files, '[]'::jsonb) || $2::jsonb,
       updated_at = NOW()`,
    [orgId, JSON.stringify([file])]
  );
  return (await getRehearsalProfile(orgId))!;
}

/** Edit a desk file's tag (label) / comment in place. */
export async function updateProfileFile(
  orgId: string,
  r2Key: string,
  updates: { label?: string | null; comment?: string | null }
): Promise<RehearsalProfile | null> {
  const profile = await getRehearsalProfile(orgId);
  if (!profile) return null;
  let found = false;
  const files = (profile.files ?? []).map((f) => {
    if (f.r2_key !== r2Key) return f;
    found = true;
    return {
      ...f,
      ...('label' in updates ? { label: updates.label ?? null } : {}),
      ...('comment' in updates ? { comment: updates.comment ?? null } : {}),
    };
  });
  if (!found) return profile;
  await query(
    `UPDATE organisation_rehearsal_profile SET files = $2::jsonb, updated_at = NOW()
     WHERE organisation_id = $1`,
    [orgId, JSON.stringify(files)]
  );
  return getRehearsalProfile(orgId);
}

export async function removeProfileFile(orgId: string, r2Key: string): Promise<RehearsalProfile | null> {
  const profile = await getRehearsalProfile(orgId);
  if (!profile) return null;
  const remaining = (profile.files ?? []).filter((f) => f.r2_key !== r2Key);
  await query(
    `UPDATE organisation_rehearsal_profile SET files = $2::jsonb, updated_at = NOW()
     WHERE organisation_id = $1`,
    [orgId, JSON.stringify(remaining)]
  );
  return getRehearsalProfile(orgId);
}

export interface LastInfoPackSent {
  sent_at: string;
  job_id: string;
  hh_job_number: number | null;
}

/**
 * Most recent info-pack send across the anchor org's rehearsal jobs — drives the
 * band-level "last sent to [Band] on …" reminder so a run of day-bookings doesn't
 * get spammed. Matches jobs whose band-role org OR client org is the anchor.
 */
export async function getLastInfoPackSent(anchorOrgId: string): Promise<LastInfoPackSent | null> {
  const res = await query(
    `SELECT rjd.info_pack_sent_at AS sent_at, j.id AS job_id, j.hh_job_number
     FROM rehearsal_job_details rjd
     JOIN jobs j ON j.id = rjd.job_id AND j.is_deleted = false
     WHERE rjd.info_pack_sent_at IS NOT NULL
       AND (
         j.client_id = $1
         OR EXISTS (
           SELECT 1 FROM job_organisations jo
           WHERE jo.job_id = j.id AND jo.role = 'band' AND jo.organisation_id = $1
         )
       )
     ORDER BY rjd.info_pack_sent_at DESC
     LIMIT 1`,
    [anchorOrgId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    sent_at: row.sent_at,
    job_id: row.job_id,
    hh_job_number: row.hh_job_number ?? null,
  };
}

function fmtRange(from: string | null, to: string | null): string {
  if (!from) return '';
  const f = (d: string) => {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  };
  if (!to || to === from) return f(from);
  return `${f(from)} – ${f(to)}`;
}

/**
 * Compose the info-pack email content for a job: boilerplate (system_settings,
 * category 'rehearsals') + per-job merge (dates + rooms from the rehearsal
 * detection) + resolved recipient. Shared by send + preview so what you preview
 * is byte-for-byte what sends.
 */
async function composeInfoPack(jobId: string): Promise<{
  to: string;
  cc: string[];
  prependBanner: string | undefined;
  variables: Record<string, string>;
  recipient: string;
  isFallback: boolean;
}> {
  const jobRes = await query(
    `SELECT id, hh_job_number, job_name, job_date, job_end,
            hh_derived_flags->'rehearsal_detail' AS rehearsal_detail
     FROM jobs WHERE id = $1 AND is_deleted = false`,
    [jobId]
  );
  const job = jobRes.rows[0];
  if (!job) throw new Error('Job not found');

  const settings = await getSystemSettings([
    'rehearsal_directions',
    'rehearsal_parking',
    'rehearsal_wifi',
    'rehearsal_amenities',
    'rehearsal_house_rules',
    'rehearsal_contact',
  ]);

  // Dates: prefer the rehearsal detection window, fall back to job dates.
  const detail = job.rehearsal_detail as { first_session_date?: string | null; last_session_date?: string | null } | null;
  const from = detail?.first_session_date ?? (job.job_date ? String(job.job_date).slice(0, 10) : null);
  const to = detail?.last_session_date ?? (job.job_end ? String(job.job_end).slice(0, 10) : null);
  const dates = fmtRange(from, to);

  // Room labels (from coverage — one per evening isn't needed; the rooms come off the detail).
  let rooms = '';
  try {
    const coverage = await getJobCoverage(jobId);
    if (coverage.length) rooms = `${coverage.length} evening${coverage.length !== 1 ? 's' : ''}`;
  } catch {
    /* non-fatal */
  }

  const target = await resolveClientEmailTarget(jobId, 'rehearsal_info_pack');
  const prependBanner = target.isFallback
    ? buildFallbackBanner({ jobId, clientName: target.clientName, jobNumber: target.jobNumber, jobName: target.jobName })
    : undefined;

  // Inline photos (durable public-bucket URLs) → img1..imgN + captions.
  const imageVars: Record<string, string> = {};
  const images = await getInfoPackImages();
  images.slice(0, MAX_INFO_PACK_IMAGES).forEach((im, i) => {
    imageVars[`img${i + 1}`] = im.url || '';
    imageVars[`img${i + 1}cap`] = im.caption || '';
  });

  return {
    to: target.primaryEmail,
    cc: target.ccEmails,
    prependBanner,
    recipient: target.primaryEmail,
    isFallback: target.isFallback,
    variables: {
      clientName: target.primaryFirstName,
      jobName: job.job_name || 'your rehearsals',
      jobNumber: String(job.hh_job_number || ''),
      dates,
      rooms,
      directions: settings.rehearsal_directions || '',
      parking: settings.rehearsal_parking || '',
      wifi: settings.rehearsal_wifi || '',
      amenities: settings.rehearsal_amenities || '',
      houseRules: settings.rehearsal_house_rules || '',
      studioContact: settings.rehearsal_contact || '',
      ...imageVars,
    },
  };
}

/**
 * Preview the info pack WITHOUT sending — returns the rendered subject + HTML
 * (client-facing, no test banner) + resolved recipient. Powers the "preview
 * before send" modal so staff can see exactly what they're about to send.
 */
export async function previewInfoPack(
  jobId: string
): Promise<{ subject: string; html: string; recipient: string; isFallback: boolean }> {
  const c = await composeInfoPack(jobId);
  const rendered = emailService.renderPreview('rehearsal_info_pack', {
    to: c.to,
    variables: c.variables,
    prependBanner: c.prependBanner,
  });
  if ('error' in rendered) throw new Error(rendered.error);
  return { subject: rendered.subject, html: rendered.html, recipient: c.recipient, isFallback: c.isFallback };
}

/**
 * Send the client info pack for a job. Composes boilerplate (system_settings,
 * category 'rehearsals') + per-job merge (dates + rooms from the rehearsal
 * detection), stamps info_pack_sent_at/_by, logs a timeline interaction.
 */
export async function sendInfoPack(
  jobId: string,
  userId: string | null
): Promise<{ recipient: string; isFallback: boolean }> {
  const c = await composeInfoPack(jobId);

  await emailService.send('rehearsal_info_pack', {
    to: c.to,
    cc: c.cc,
    prependBanner: c.prependBanner,
    variables: c.variables,
  });

  await query(
    `INSERT INTO rehearsal_job_details (job_id, info_pack_sent_at, info_pack_sent_by)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (job_id) DO UPDATE SET
       info_pack_sent_at = NOW(), info_pack_sent_by = $2, updated_at = NOW()`,
    [jobId, userId]
  );

  if (c.isFallback) {
    await logFallbackToTimeline({ jobId, templateId: 'rehearsal_info_pack' });
  } else {
    const content = `📋 Rehearsal info pack sent to ${c.recipient}.`;
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, source)
       VALUES ('email', $1, $2, $3, 'system')`,
      [content, jobId, userId]
    );
  }

  return { recipient: c.recipient, isFallback: c.isFallback };
}
