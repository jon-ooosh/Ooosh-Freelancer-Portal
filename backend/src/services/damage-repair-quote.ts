/**
 * Damage Repair Quote Sender — TTS360 (or whichever engineering contact is
 * configured in system_settings under `tts360_engineering_email`).
 *
 * One email per send call, covering one or more job_issues rows that all
 * belong to the same vehicle. Photos are read from job_issue_files
 * (file_type='photo') and rendered as inline thumbnails linked to full
 * size on the public R2 bucket — same "click-the-image" pattern the
 * condition-report PDF uses.
 *
 * Side effects per issue on a successful send:
 *   - Inserts a `quote_requested` event into job_issue_events with metadata
 *     { recipients, sent_by, email_log_id }
 *   - Flips status → 'awaiting_quote' (only when current status is in the
 *     non-terminal set; never downgrades a resolved/written_off/cancelled
 *     issue, and never overwrites quoted/actioned which mean staff have
 *     already moved past the quote stage).
 *
 * Caller is responsible for RBAC + loading user context. This service
 * just resolves recipients, loads photos, calls emailService.send, and
 * logs the side effects.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getSystemSettings } from '../routes/system-settings';

export interface DamageRepairQuoteResult {
  success: boolean;
  email_log_id: string | null;
  message_id: string | null;
  error: string | null;
  recipients: { to: string; cc: string[] };
  issue_ids: string[];
  photo_count: number;
}

interface IssueRow {
  id: string;
  job_id: string | null;
  vehicle_id: string | null;
  vehicle_reg: string | null;
  vehicle_name: string | null;
  hh_job_number: number | null;
  status: string;
  category: string;
  summary: string;
  description: string | null;
  created_at: Date;
}

interface PhotoRow {
  id: string;
  issue_id: string;
  r2_key: string;
  filename: string | null;
}

const NON_TRANSITIONABLE_STATUSES = new Set([
  'resolved', 'written_off', 'cancelled', 'quoted', 'actioned',
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function publicPhotoUrl(r2Key: string): string {
  const base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) return r2Key; // best-effort: rendering as plain text is better than crashing
  return `${base}/${r2Key.replace(/^\/+/, '')}`;
}

function renderPhotoGrid(photos: PhotoRow[]): string {
  if (!photos.length) {
    return `<p style="margin:12px 0;font-size:14px;color:#64748b;font-style:italic;">No photos attached to this report.</p>`;
  }
  const cells = photos.map(p => {
    const url = publicPhotoUrl(p.r2_key);
    return `
      <td style="padding:4px;vertical-align:top;width:33%;">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:block;">
          <img src="${escapeHtml(url)}" alt="Damage photo" style="display:block;width:100%;max-width:200px;border:1px solid #e2e8f0;border-radius:4px;" />
        </a>
      </td>`;
  });
  // Pack into rows of 3.
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 3) {
    const row = cells.slice(i, i + 3).join('');
    // Pad short final row with empty cells for alignment.
    const padCount = 3 - (cells.length - i);
    const padding = padCount > 0 ? '<td style="width:33%"></td>'.repeat(Math.min(padCount, 2)) : '';
    rows.push(`<tr>${row}${padding}</tr>`);
  }
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:8px 0 16px;">
      ${rows.join('')}
    </table>
    <p style="margin:0 0 16px;font-size:12px;color:#64748b;">Tap or click any photo to view the full-size image.</p>
  `;
}

function joinDamageNotes(issues: IssueRow[]): string {
  const parts: string[] = [];
  for (const i of issues) {
    const head = i.summary || 'Damage';
    const body = i.description ? `: ${i.description}` : '';
    parts.push(`• ${head}${body}`);
  }
  return parts.join('\n');
}

/**
 * Send a repair-quote request covering the given issue IDs.
 *
 * Returns a structured result either way — caller decides how to surface
 * failures. The OP record (event log + status flip) is only written on
 * a successful SMTP send so a transient failure leaves the issue in a
 * state that the IssueDetailPage 'Not sent' banner can still recover.
 */
export async function sendDamageRepairQuote(opts: {
  issueIds: string[];
  sentByUserId: string;
  sentByName?: string | null;
  notesOverride?: string | null;
}): Promise<DamageRepairQuoteResult> {
  const result: DamageRepairQuoteResult = {
    success: false,
    email_log_id: null,
    message_id: null,
    error: null,
    recipients: { to: '', cc: [] },
    issue_ids: [],
    photo_count: 0,
  };

  if (!opts.issueIds.length) {
    result.error = 'No issue IDs supplied';
    return result;
  }

  // Load issues + their vehicle + linked job (for HH job number).
  const issuesResult = await query(
    `SELECT ji.id, ji.job_id, ji.vehicle_id, ji.status, ji.category,
            ji.summary, ji.description, ji.created_at,
            fv.reg          AS vehicle_reg,
            fv.vehicle_name AS vehicle_name,
            j.hh_job_number AS hh_job_number
       FROM job_issues ji
       LEFT JOIN fleet_vehicles fv ON fv.id = ji.vehicle_id
       LEFT JOIN jobs j ON j.id = ji.job_id
      WHERE ji.id = ANY($1::uuid[])
      ORDER BY ji.created_at ASC`,
    [opts.issueIds]
  );

  const issues = issuesResult.rows as IssueRow[];
  if (!issues.length) {
    result.error = 'No matching issues found';
    return result;
  }
  result.issue_ids = issues.map(i => i.id);

  // All issues must share the same vehicle — one TTS360 email per van.
  const vehicleIds = new Set(issues.map(i => i.vehicle_id).filter(Boolean));
  if (vehicleIds.size !== 1) {
    result.error = 'All issues in a single repair-quote send must share the same vehicle';
    return result;
  }

  const vanReg = issues[0]!.vehicle_reg || 'UNKNOWN';
  const hhJobNumber = issues[0]!.hh_job_number;

  // Load photos linked to these issues.
  const photosResult = await query(
    `SELECT id, issue_id, r2_key, filename
       FROM job_issue_files
      WHERE issue_id = ANY($1::uuid[])
        AND file_type = 'photo'
      ORDER BY uploaded_at ASC`,
    [opts.issueIds]
  );
  const photos = photosResult.rows as PhotoRow[];
  result.photo_count = photos.length;

  // Pull recipient + contract-ref settings (cached briefly in
  // system-settings.ts so this is cheap on resend bursts).
  const settings = await getSystemSettings([
    'tts360_engineering_email',
    'tts360_cc_email',
    'tts360_contract_reference',
  ]);
  const to = (settings['tts360_engineering_email'] || '').trim();
  const ccRaw = (settings['tts360_cc_email'] || '').trim();
  if (!to) {
    result.error = 'TTS360 engineering email is not configured in system settings';
    return result;
  }
  const cc = ccRaw ? ccRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  result.recipients = { to, cc };

  // Contract reference: use the configured fixed value if present,
  // otherwise fall back to the HH job number. Match the user's email
  // wording ("our contract reference {contractNumber}").
  const contractRef = (settings['tts360_contract_reference'] || '').trim()
    || (hhJobNumber ? String(hhJobNumber) : 'N/A');

  // Body — kept close to the wording the team agreed.
  const notes = (opts.notesOverride && opts.notesOverride.trim()) || joinDamageNotes(issues);
  const notesHtml = escapeHtml(notes).replace(/\n/g, '<br />');

  const bodyHtml = `
    <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi,</p>
    <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
      Please see attached photos of damage to <strong>${escapeHtml(vanReg)}</strong>,
      our contract reference <strong>${escapeHtml(contractRef)}</strong>.
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
      Please can you quote for repair?
    </p>
    ${renderPhotoGrid(photos)}
    <p style="margin:0 0 8px;font-size:15px;color:#334155;line-height:1.6;">Our notes are:</p>
    <p style="margin:0 0 20px;padding:10px 12px;background:#f8fafc;border-left:3px solid #cbd5e1;font-size:14px;color:#334155;line-height:1.6;white-space:pre-wrap;">${notesHtml}</p>
    <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
      We look forward to hearing from you — please email
      <a href="mailto:will@oooshtours.co.uk">will@oooshtours.co.uk</a> or
      <a href="mailto:info@oooshtours.co.uk">info@oooshtours.co.uk</a>.
    </p>
    <p style="margin:0 0 4px;font-size:15px;color:#334155;line-height:1.6;">Thanks,</p>
    <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">Ooosh! Tours Ltd</p>
  `;

  const sendResult = await emailService.send('damage_repair_quote_request', {
    to,
    cc,
    variables: {
      vanRegistration: vanReg,
      hhJobNumber: hhJobNumber ? String(hhJobNumber) : 'N/A',
    },
    bodyHtmlOverride: bodyHtml,
  });

  if (!sendResult.success) {
    result.error = sendResult.error || 'Email send failed';
    return result;
  }

  result.success = true;
  result.email_log_id = sendResult.logId || null;
  result.message_id = sendResult.messageId || null;

  // Record the side effects per issue. Best-effort: SMTP went through,
  // so if the audit insert fails we still return success but log loudly.
  for (const issue of issues) {
    try {
      await query(
        `INSERT INTO job_issue_events
           (issue_id, event_type, body, metadata, created_by)
         VALUES ($1, 'quote_requested', $2, $3::jsonb, $4)`,
        [
          issue.id,
          `Sent damage repair quote request to ${to}${cc.length ? ` (cc ${cc.join(', ')})` : ''}`,
          JSON.stringify({
            email_log_id: sendResult.logId || null,
            message_id: sendResult.messageId || null,
            recipients: { to, cc },
            contract_ref: contractRef,
            photo_count: photos.length,
            sent_by_name: opts.sentByName || null,
          }),
          opts.sentByUserId,
        ]
      );

      // Status flip — only when the issue is in a state where
      // "awaiting_quote" is a meaningful forward move. Don't clobber
      // staff progress (quoted/actioned) and don't reopen resolved
      // rows — a resend on a resolved issue is just an audit record.
      if (!NON_TRANSITIONABLE_STATUSES.has(issue.status)) {
        await query(
          `UPDATE job_issues
             SET status = 'awaiting_quote',
                 updated_at = NOW()
           WHERE id = $1 AND status = $2`,
          [issue.id, issue.status]
        );
      } else {
        await query(`UPDATE job_issues SET updated_at = NOW() WHERE id = $1`, [issue.id]);
      }
    } catch (auditErr) {
      console.error('[damage-repair-quote] audit insert failed for issue', issue.id, auditErr);
    }
  }

  return result;
}

/**
 * Has a repair-quote ever been sent for this issue? Reads job_issue_events.
 * Cheap helper for the frontend list endpoints + the 'Not sent' pill —
 * avoids round-tripping the full event timeline.
 */
export async function hasRepairQuoteBeenSent(issueId: string): Promise<{
  sent: boolean;
  last_sent_at: Date | null;
  send_count: number;
}> {
  const result = await query(
    `SELECT COUNT(*)::int AS n, MAX(created_at) AS last_sent_at
       FROM job_issue_events
      WHERE issue_id = $1 AND event_type = 'quote_requested'`,
    [issueId]
  );
  const row = result.rows[0] as { n: number; last_sent_at: Date | null };
  return {
    sent: row.n > 0,
    last_sent_at: row.last_sent_at,
    send_count: row.n,
  };
}
