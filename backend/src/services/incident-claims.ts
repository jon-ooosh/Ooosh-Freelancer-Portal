/**
 * Incident & possible insurance claims — shared helpers
 * (docs/INCIDENT-CLAIMS-SPEC.md). routes/incident-claims.ts is the HTTP
 * surface; this file holds everything another module also calls:
 *
 *   - createClaimFromIssue()      — THE way a case is opened (spec D1: always
 *                                   from a Problem)
 *   - autoLinkIssueToOpenClaim()  — check-in damage joins an open case on the
 *                                   same van + job (spec §3 step 3)
 *   - runClaimCheckReminders()    — the daily "check in on this case" bell (§9.2)
 *   - getClaimAttentionBuckets()  — dashboard Needs Attention (§9.3)
 *
 * Claims OUTLIVE their jobs (§3.1): nothing here gates on the job's
 * pipeline status. The case's own `stage` decides.
 */
import { query, getClient } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import { logIssueEvent } from './job-issues';
import { defaultFormData } from './claim-form-fields';
import { estimateVehicleValue } from './vehicle-value';

type DbClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export const CLAIM_STAGES = ['open', 'form_out', 'submitted', 'reviewed', 'with_broker', 'closed'] as const;
export type ClaimStage = (typeof CLAIM_STAGES)[number];

/** How the incident first reached us (migration 260). */
export const NOTIFIED_VIA = ['client', 'tts360', 'third_party', 'check_in', 'other'] as const;
export type NotifiedVia = (typeof NOTIFIED_VIA)[number];

/** File types an insurer would expect by default (share_with_insurer pre-ticked). */
export const SHARED_BY_DEFAULT: ReadonlySet<string> = new Set(['photo', 'police_report', 'repair_quote']);

export const CLAIM_OUTCOMES = ['not_claimed', 'settled', 'denied', 'defended', 'withdrawn'] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

/** Stages that chase themselves (the client chase) and so need no check date. */
const SELF_CHASING: ReadonlySet<string> = new Set(['form_out']);

export async function logClaimEvent(
  claimId: string,
  userId: string | null,
  eventType: string,
  body: string | null,
  metadata: Record<string, unknown> | null = null,
  opts?: { client?: DbClient; eventDate?: string | null },
): Promise<void> {
  const run = opts?.client ? opts.client.query.bind(opts.client) : query;
  await run(
    `INSERT INTO incident_claim_events (claim_id, event_type, event_date, body, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [claimId, eventType, opts?.eventDate ?? null, body, metadata ? JSON.stringify(metadata) : null, userId],
  );
}

export async function getDefaultClaimWatchers(): Promise<string[]> {
  const raw = await getSystemSetting('claims_default_watchers');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    console.warn('claims_default_watchers: invalid JSON, ignoring');
    return [];
  }
}

/** YYYY-MM-DD for "today + n days" in UK terms. */
export function ukDatePlus(days: number): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  now.setDate(now.getDate() + days);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Next Mon–Fri after today (bank holidays not considered — a bell a day early is harmless). */
export function nextWorkingDay(): string {
  for (let i = 1; i <= 7; i++) {
    const s = ukDatePlus(i);
    const dow = new Date(`${s}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return s;
  }
  return ukDatePlus(1);
}

/**
 * Bell the people following a case. Recipients: watchers + owner + default
 * watchers, minus the actor. Bodies NEVER carry injury / declaration / driver
 * personal details (spec §15) — the bell links to the case instead.
 * Best-effort: failures are logged, never thrown.
 */
export async function notifyClaimFollowers(
  claimId: string,
  actorUserId: string | null,
  title: string,
  content: string,
  opts: { priority?: 'low' | 'normal' | 'high' | 'urgent'; onlyUserIds?: string[] } = {},
): Promise<void> {
  try {
    let recipients: Set<string>;
    if (opts.onlyUserIds) {
      recipients = new Set(opts.onlyUserIds);
    } else {
      const r = await query(`SELECT watchers, owner_user_id FROM incident_claims WHERE id = $1`, [claimId]);
      if (r.rowCount === 0) return;
      recipients = new Set<string>((r.rows[0].watchers as string[] | null) || []);
      if (r.rows[0].owner_user_id) recipients.add(r.rows[0].owner_user_id);
      for (const w of await getDefaultClaimWatchers()) recipients.add(w);
    }
    if (actorUserId) recipients.delete(actorUserId);
    for (const userId of recipients) {
      await query(
        `INSERT INTO notifications
           (user_id, type, title, content, entity_type, entity_id, action_url, priority, source_user_id)
         VALUES ($1, 'system', $2, $3, 'incident_claims', $4, $5, $6, $7)`,
        [userId, title, content, claimId, `/vehicles/claims/${claimId}`, opts.priority || 'normal', actorUserId],
      );
    }
  } catch (err) {
    console.error('Claim notification failed (non-fatal):', err);
  }
}

/** Short human label for a case — "RF21 PWX (#16063)". */
export function claimLabel(row: { vehicle_reg?: string | null; hh_job_number?: number | null }): string {
  const reg = row.vehicle_reg || 'no van';
  return row.hh_job_number ? `${reg} (#${row.hh_job_number})` : reg;
}

export interface CreateClaimResult {
  claimId: string;
  existing: boolean;
}

/**
 * Open a possible-claim case from a Problem (spec D1). Idempotent: a Problem
 * already on a case returns that case. The case anchors to the Problem's job
 * and van; when the Problem has no van but its job has exactly one, that van
 * is used. Transactional so a double-click can't open two cases.
 */
export async function createClaimFromIssue(
  issueId: string,
  userId: string,
  opts: { thirdPartyClaim?: boolean; notifiedOn?: string | null; incidentDate?: string | null; notifiedVia?: NotifiedVia | null } = {},
): Promise<CreateClaimResult> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const issueRes = await client.query(
      `SELECT ji.id, ji.claim_id, ji.job_id, ji.vehicle_id, ji.driver_id, ji.summary, ji.description,
              ji.source_module, j.hh_job_number
       FROM job_issues ji
       LEFT JOIN jobs j ON j.id = ji.job_id
       WHERE ji.id = $1
       FOR UPDATE OF ji`,
      [issueId],
    );
    if (issueRes.rowCount === 0) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error('Problem not found'), { status: 404 });
    }
    const issue = issueRes.rows[0];
    if (issue.claim_id) {
      await client.query('ROLLBACK');
      return { claimId: issue.claim_id, existing: true };
    }

    let vehicleId: string | null = issue.vehicle_id;
    if (!vehicleId && issue.job_id) {
      const vans = await client.query(
        `SELECT DISTINCT vehicle_id FROM vehicle_hire_assignments
         WHERE job_id = $1 AND status <> 'cancelled' AND vehicle_id IS NOT NULL`,
        [issue.job_id],
      );
      if (vans.rows.length === 1) vehicleId = vans.rows[0].vehicle_id;
    }
    const watchers = Array.from(new Set([userId, ...(await getDefaultClaimWatchers())]));
    const formData = defaultFormData();
    if (opts.incidentDate) formData.incident = { ...(formData.incident || {}), date: opts.incidentDate };

    let reg: string | null = null;
    if (vehicleId) {
      const v = await client.query(
        `SELECT reg, cash_price, deposit_paid, amount_financed, date_first_reg FROM fleet_vehicles WHERE id = $1`,
        [vehicleId],
      );
      reg = v.rows[0]?.reg ?? null;
      // Pre-fill the broker's "approx. vehicle value" (§6.6). The form is
      // visible to all staff, so always the £500-rounded non-admin figure.
      if (v.rows[0]) {
        const est = await estimateVehicleValue(v.rows[0], { isAdmin: false });
        if (est) formData.our_vehicle = { ...(formData.our_vehicle || {}), value: est.value_ex_vat };
      }
    }

    // How we heard, where OP can tell: check-in found it, or the third party
    // told us. Anything else (client call, TTS360) staff set on the case.
    const notifiedVia: NotifiedVia | null = opts.notifiedVia
      ?? (opts.thirdPartyClaim ? 'third_party' : issue.source_module === 'vehicle' ? 'check_in' : null);

    const insert = await client.query(
      `INSERT INTO incident_claims (
         origin_issue_id, job_id, vehicle_id, driver_id, hh_job_number, vehicle_reg,
         incident_at, notified_on, form_data, third_party_claim,
         owner_user_id, next_check_on, watchers, created_by, notified_via
       ) VALUES ($1, $2, $3, $4, $5, $6,
                 $7::date, COALESCE($8::date, CURRENT_DATE), $9::jsonb, $10,
                 $11, $12::date, $13::uuid[], $11, $14)
       RETURNING id`,
      [
        issue.id, issue.job_id, vehicleId, issue.driver_id, issue.hh_job_number, reg,
        opts.incidentDate || null, opts.notifiedOn || null, JSON.stringify(formData), !!opts.thirdPartyClaim,
        userId, ukDatePlus(3), watchers, notifiedVia,
      ],
    );
    const claimId: string = insert.rows[0].id;

    await client.query(`UPDATE job_issues SET claim_id = $2, updated_at = NOW() WHERE id = $1`, [issue.id, claimId]);
    await logClaimEvent(claimId, userId, 'created', `Opened from Problem: ${issue.summary}`, {
      issue_id: issue.id, third_party_claim: !!opts.thirdPartyClaim,
    }, { client });
    await logIssueEvent(issue.id, userId, 'claim_opened', 'Possible insurance claim opened', { claim_id: claimId }, { client });

    await client.query('COMMIT');
    return { claimId, existing: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check-in damage → join an open case on the same van + job (spec §3 step 3).
 * No-op when the Problem is already on a case, or there's no open case, or
 * more than one open case matches (ambiguous — staff link by hand).
 * Best-effort: never throws into the caller's check-in flow.
 */
export async function autoLinkIssueToOpenClaim(
  issueId: string,
  vehicleId: string | null,
  jobId: string | null,
  userId: string,
): Promise<string | null> {
  if (!vehicleId || !jobId) return null;
  try {
    const open = await query(
      `SELECT id FROM incident_claims
       WHERE vehicle_id = $1 AND job_id = $2 AND stage <> 'closed' AND is_deleted = false`,
      [vehicleId, jobId],
    );
    if (open.rows.length !== 1) return null;
    const claimId: string = open.rows[0].id;
    const upd = await query(
      `UPDATE job_issues SET claim_id = $2, updated_at = NOW()
       WHERE id = $1 AND claim_id IS NULL
       RETURNING summary`,
      [issueId, claimId],
    );
    if (!upd.rowCount) return null;
    await logClaimEvent(claimId, userId, 'problem_linked', `Linked automatically at check-in: ${upd.rows[0].summary}`, {
      issue_id: issueId, auto: true,
    });
    await logIssueEvent(issueId, userId, 'claim_linked', 'Linked to the open insurance claim on this van + job', { claim_id: claimId });
    await query(`UPDATE incident_claims SET updated_at = NOW() WHERE id = $1`, [claimId]);
    return claimId;
  } catch (err) {
    console.error('autoLinkIssueToOpenClaim failed (non-fatal):', err);
    return null;
  }
}

/**
 * Daily 09:22: bell the owner of every case whose check date has arrived.
 * Stamp-first on next_check_sent_for so a re-run the same day (or a crash
 * mid-send) can't double-bell; moving the date re-arms it. A case that stays
 * overdue is held on Needs Attention rather than re-belled every day.
 */
export async function runClaimCheckReminders(): Promise<{ belled: number }> {
  const due = await query(
    `UPDATE incident_claims
        SET next_check_sent_for = next_check_on
      WHERE is_deleted = false
        AND stage NOT IN ('closed', 'form_out')
        AND next_check_on IS NOT NULL
        AND next_check_on <= CURRENT_DATE
        AND next_check_sent_for IS DISTINCT FROM next_check_on
      RETURNING id, stage, vehicle_reg, hh_job_number, owner_user_id, watchers, updated_at`,
  );
  let belled = 0;
  for (const c of due.rows) {
    const days = Math.max(0, Math.floor((Date.now() - new Date(c.updated_at).getTime()) / 86400000));
    const recipients: string[] = c.owner_user_id
      ? [c.owner_user_id]
      : ((c.watchers as string[] | null) || []);
    if (!recipients.length) continue;
    await notifyClaimFollowers(
      c.id, null,
      `Check in on claim — ${claimLabel(c)}`,
      `${STAGE_LABEL[c.stage as ClaimStage] || c.stage}; last update ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}.`,
      { onlyUserIds: recipients },
    );
    belled++;
  }
  return { belled };
}

export const STAGE_LABEL: Record<ClaimStage, string> = {
  open: 'Open',
  form_out: 'Form out',
  submitted: 'Awaiting review',
  reviewed: 'Reviewed — broker not notified',
  with_broker: 'With broker',
  closed: 'Closed',
};

export interface ClaimAttentionRow {
  id: string;
  stage: string;
  vehicle_reg: string | null;
  hh_job_number: number | null;
  next_check_on: string | null;
  owner_name: string | null;
}

/**
 * Needs Attention (§9.3): open cases whose check date has passed or is
 * missing. (The client-chase bucket arrives with Phase 3.) Full total plus a
 * capped item list — never bucket a LIMIT-ed set client-side.
 */
export async function getClaimAttentionBuckets(): Promise<{ check_overdue: ClaimAttentionRow[]; check_overdue_total: number }> {
  const r = await query(
    `SELECT c.id, c.stage, c.vehicle_reg, c.hh_job_number,
            to_char(c.next_check_on, 'YYYY-MM-DD') AS next_check_on,
            NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), '') AS owner_name,
            COUNT(*) OVER () AS total
     FROM incident_claims c
     LEFT JOIN users u ON u.id = c.owner_user_id
     LEFT JOIN people p ON p.id = u.person_id
     WHERE c.is_deleted = false
       AND c.stage NOT IN ('closed', 'form_out')
       AND (c.next_check_on IS NULL OR c.next_check_on < CURRENT_DATE)
     ORDER BY c.next_check_on NULLS FIRST
     LIMIT 10`,
  );
  const total = r.rows[0] ? Number(r.rows[0].total) : 0;
  return {
    check_overdue: r.rows.map(({ total: _t, ...row }) => row as ClaimAttentionRow),
    check_overdue_total: total,
  };
}

/** Whether a stage needs a next-check date (everything but self-chasing and closed). */
export function stageNeedsCheckDate(stage: string): boolean {
  return stage !== 'closed' && !SELF_CHASING.has(stage);
}

/**
 * @mentions in a case update — the same bell + immediate email the Problems
 * and timeline composers give (routes/interactions.ts), honouring each user's
 * 'mention' delivery preference. Stamps email_sent_at at insert when emailing
 * so the escalator doesn't double-fire. Best-effort: never throws.
 */
export async function notifyClaimMentions(
  claimId: string,
  actorUserId: string,
  mentionedUserIds: string[],
  text: string,
): Promise<void> {
  const ids = Array.from(new Set(mentionedUserIds.filter((id) => id && id !== actorUserId)));
  if (!ids.length) return;
  try {
    const actor = await query(
      `SELECT NULLIF(TRIM(CONCAT(COALESCE(NULLIF(p.preferred_name, ''), p.first_name), ' ', p.last_name)), '') AS name, u.email
       FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
      [actorUserId],
    );
    const creatorName: string = actor.rows[0]?.name || actor.rows[0]?.email || 'Someone';
    const c = await query(`SELECT vehicle_reg, hh_job_number FROM incident_claims WHERE id = $1`, [claimId]);
    const label = claimLabel(c.rows[0] || {});
    const recipients = await query(
      `SELECT u.id, u.email, p.first_name, p.preferred_name,
              COALESCE((SELECT delivery_method FROM user_notification_preferences
                         WHERE user_id = u.id AND notification_type = 'mention'), 'both') AS pref
       FROM users u LEFT JOIN people p ON p.id = u.person_id
       WHERE u.id = ANY($1::uuid[]) AND u.is_active = true`,
      [ids],
    );
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    const actionUrl = `/vehicles/claims/${claimId}`;
    const { emailService } = await import('./email-service');
    const { frontendLink } = await import('../config/app-urls');
    const esc = (s: string) => s.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] as string));
    for (const r of recipients.rows) {
      const wantsEmail = (r.pref === 'email' || r.pref === 'both') && !!r.email;
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id,
           source_user_id, action_url, priority, email_sent_at)
         VALUES ($1, 'mention', $2, $3, 'incident_claims', $4, $5, $6, 'normal', ${wantsEmail ? 'NOW()' : 'NULL'})`,
        [r.id, `${creatorName} mentioned you on claim ${label}`, preview, claimId, actorUserId, actionUrl],
      );
      if (wantsEmail) {
        const hi = (r.preferred_name || '').trim() || r.first_name || 'there';
        const result = await emailService.sendRaw({
          to: r.email,
          subject: `${creatorName} mentioned you on claim ${label}`,
          html: `
            <p>Hi ${esc(hi)},</p>
            <p style="font-size: 15px; margin: 16px 0;"><strong>${esc(creatorName)} mentioned you on insurance claim ${esc(label)}</strong></p>
            <p style="color: #333; white-space: pre-wrap;">${esc(preview)}</p>
            <p><a href="${frontendLink(actionUrl)}" style="color: #7B5EA7; text-decoration: underline;">View in Ooosh</a></p>
            <p style="color: #999; font-size: 12px; margin-top: 24px;">
              You're receiving this because you were @mentioned on the Ooosh Operations Platform.
              Adjust your notification preferences in your Inbox settings.
            </p>`,
          variant: 'internal',
        });
        if (!result.success) console.error(`[claims] mention email to ${r.email} failed:`, result.error);
      }
    }
  } catch (err) {
    console.error('Claim mention notify failed (non-fatal):', err);
  }
}
