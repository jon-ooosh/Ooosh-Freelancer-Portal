/**
 * Pre-Hire Review email rendering.
 *
 * Internal email — goes to info@oooshtours.co.uk every morning for each
 * confirmed job approaching its hire date. Replaces the Monday.com
 * automation that did the same thing with much less context.
 *
 * The renderer takes a structured JobBriefing (built by
 * services/pre-hire-briefing.ts) and produces an HTML body + subject line.
 *
 * Includes a "copy-paste this to the client" block built deterministically
 * from the briefing — staff edit, paste, send. No automatic client contact.
 */

import type {
  JobBriefing, BriefingFlag, BriefingDriver, BriefingCrew,
} from '../pre-hire-briefing';
import type {
  ProgressStripCategory, ProgressStripStatus, JobProgressStrip,
} from '../job-progress-strip';

const STRIP_CAT_LABELS: Record<ProgressStripCategory, string> = {
  deprep: 'Backline',
  client: 'Hire Form',
  excess: 'Excess',
  freelancer: 'Freelancer',
  invoicing: 'Invoicing',
  payment: 'Payment',
  vehicle: 'Vehicle',
};

const STRIP_CAT_ORDER: ProgressStripCategory[] = [
  'vehicle', 'client', 'excess', 'deprep', 'freelancer', 'payment', 'invoicing',
];

const STATUS_HEX: Record<ProgressStripStatus, { bg: string; fg: string }> = {
  done: { bg: '#dcfce7', fg: '#15803d' },   // green-100/700
  wip: { bg: '#fef3c7', fg: '#a16207' },    // amber-100/700
  todo: { bg: '#f3f4f6', fg: '#374151' },   // gray-100/700
  prob: { bg: '#fee2e2', fg: '#b91c1c' },   // red-100/700
};

const STATUS_LABEL: Record<ProgressStripStatus, string> = {
  done: 'Done',
  wip: 'In progress',
  todo: 'To do',
  prob: 'Problem',
};

// ── Helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Header-style date: "Tue, 12 May 2026". For the briefing card. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

/** Friendly client-facing date: "Tuesday 12 May" (no year for near-term). */
function formatFriendlyDate(iso: string | null): string {
  if (!iso) return 'soon';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    return iso;
  }
}

/** Short date with year (used inside paragraphs alongside other dates). */
function formatShortDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

function formatTime(t: string | null | undefined): string {
  if (!t) return '';
  return t.slice(0, 5);
}

function daysToOutLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function pluralise(n: number, single: string, plural?: string): string {
  return n === 1 ? single : (plural || `${single}s`);
}

// ── Subject line ────────────────────────────────────────────────────────

export function buildSubject(b: JobBriefing): string {
  const urgent = b.red_flags.some(f => f.severity === 'urgent');
  const prefix = urgent
    ? '🚨 [URGENT]'
    : `[Pre-Hire ${b.job.days_to_out}d]`;
  const ref = b.job.hh_job_number ? ` #${b.job.hh_job_number}` : '';
  const who = b.job.client_name || b.job.company_name || 'Client TBC';
  const what = b.job.job_name && b.job.job_name !== 'Untitled job' ? ` — ${b.job.job_name}` : '';
  const open = b.outstanding.length;
  const tail = open > 0 ? ` (${open} outstanding)` : ' (all set)';
  return `${prefix}${ref} ${who}${what}${tail}`;
}

// ── Component renderers ─────────────────────────────────────────────────

function renderHeader(b: JobBriefing): string {
  // Pickup line: out_date + out_time. If out_time is the system default
  // (null/09:00), show the date but flag with "(time TBC)".
  const startDate = formatDate(b.job.out_date || b.job.job_date);
  const startTime = formatTime(b.job.out_time);
  const startBits = [startDate];
  if (startTime && !b.job.is_default_pickup_time) startBits.push(startTime);
  else if (b.job.is_default_pickup_time) startBits.push('time TBC');

  // CLIENT-FACING return reference uses job_end (the real end of charge).
  // return_date is OP's +1 buffer for warehouse turnaround — internal only.
  const endDate = formatDate(b.job.job_end || b.job.return_date);
  const endTime = formatTime(b.job.return_time);
  const endBits = [endDate];
  if (endTime) endBits.push(endTime);

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="padding:16px 18px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;">
          <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#6b21a8;font-weight:600;">
            ${b.job.hh_job_number ? `#${b.job.hh_job_number} &middot; ` : ''}Hire starts ${escapeHtml(daysToOutLabel(b.job.days_to_out))}
          </p>
          <p style="margin:0 0 6px;font-size:18px;color:#1e293b;font-weight:700;line-height:1.3;">
            ${escapeHtml(b.job.client_name || b.job.company_name || 'Unknown client')} — ${escapeHtml(b.job.job_name)}
          </p>
          <p style="margin:0;font-size:13px;color:#475569;line-height:1.5;">
            <strong>Start:</strong> ${escapeHtml(startBits.join(' · '))}<br>
            <strong>Return:</strong> ${escapeHtml(endBits.join(' · '))}
            ${b.job.venue_name ? `<br><strong>Venue:</strong> ${escapeHtml(b.job.venue_name)}` : ''}
          </p>
        </td>
      </tr>
    </table>
  `;
}

function renderRedFlags(flags: BriefingFlag[]): string {
  const urgent = flags.filter(f => f.severity === 'urgent');
  const warnings = flags.filter(f => f.severity === 'warning');
  if (urgent.length === 0 && warnings.length === 0) return '';
  const items: string[] = [];
  for (const f of urgent) {
    items.push(`<li style="color:#b91c1c;font-weight:600;margin:0 0 4px;">🚨 ${escapeHtml(f.label)}</li>`);
  }
  for (const f of warnings) {
    items.push(`<li style="color:#a16207;margin:0 0 4px;">⚠️ ${escapeHtml(f.label)}</li>`);
  }
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="padding:14px 18px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;">
          <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#b91c1c;font-weight:700;">
            Action needed today
          </p>
          <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;">
            ${items.join('')}
          </ul>
        </td>
      </tr>
    </table>
  `;
}

function renderProgressStrip(strip: JobProgressStrip): string {
  const cells: string[] = [];
  for (const cat of STRIP_CAT_ORDER) {
    const status = strip[cat];
    if (status === undefined) continue;
    const c = STATUS_HEX[status];
    cells.push(`
      <td style="padding:6px 10px;background:${c.bg};color:${c.fg};border-radius:6px;font-size:12px;font-weight:600;text-align:center;">
        ${escapeHtml(STRIP_CAT_LABELS[cat])}<br>
        <span style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.4px;">${escapeHtml(STATUS_LABEL[status])}</span>
      </td>
    `);
  }
  if (cells.length === 0) return '';
  // Render with a small gap between cells via spacer columns
  const cellsWithGaps = cells.flatMap((cell, i) =>
    i === 0 ? [cell] : [`<td style="width:6px;">&nbsp;</td>`, cell],
  );
  return `
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">
      Status overview
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr>${cellsWithGaps.join('')}</tr>
    </table>
  `;
}

function renderOutstanding(b: JobBriefing): string {
  if (b.outstanding.length === 0) return '';
  const rows = b.outstanding.map(r => {
    const dot = r.status === 'in_progress' ? '🟡' : r.status === 'blocked' ? '🔴' : '⚪';
    const noteHtml = r.notes ? ` <span style="color:#64748b;">— ${escapeHtml(r.notes)}</span>` : '';
    return `<li style="margin:0 0 4px;">${dot} <strong>${escapeHtml(r.label)}</strong>${noteHtml}</li>`;
  }).join('');
  return `
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">
      Outstanding (${b.outstanding.length})
    </p>
    <ul style="margin:0 0 20px;padding-left:20px;font-size:14px;color:#1e293b;line-height:1.5;">
      ${rows}
    </ul>
  `;
}

function renderTransportSummary(b: JobBriefing): string {
  if (b.transport.length === 0) return '';
  const rows: string[] = [];
  for (const t of b.transport) {
    const venue = t.venue || 'venue TBC';
    const dateStr = t.job_date ? formatDate(t.job_date) : '';
    const timeStr = t.arrival_time ? formatTime(t.arrival_time) : '';
    const when = [dateStr, timeStr].filter(Boolean).join(' · ');
    const opsLabel = t.ops_status ? ` <span style="color:#64748b;">(${escapeHtml(t.ops_status)})</span>` : '';
    const introWarning = t.client_intro_status === 'todo' || t.client_intro_status === 'working_on_it'
      ? ` <span style="color:#a16207;font-weight:600;">— intro to client not yet done</span>`
      : '';
    const verb = t.job_type === 'collection' ? 'Collecting from' : t.job_type === 'crewed' ? 'Crewed at' : 'Delivering to';
    rows.push(`<li style="margin:0 0 4px;"><strong>${escapeHtml(verb)}</strong> ${escapeHtml(venue)}${when ? ` — ${escapeHtml(when)}` : ''}${opsLabel}${introWarning}</li>`);
  }
  return `
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">
      Transport
    </p>
    <ul style="margin:0 0 20px;padding-left:20px;font-size:14px;color:#1e293b;line-height:1.5;">
      ${rows.join('')}
    </ul>
  `;
}

function renderMoneyAndPeople(b: JobBriefing): string {
  const m = b.money;
  const moneyLines: string[] = [];
  if (m.hire_value > 0) {
    if (m.hh_billing_loaded) {
      if (m.balance_outstanding > 0) {
        moneyLines.push(`<strong>Hire fee:</strong> £${m.balance_outstanding.toFixed(2)} due (£${m.deposits_paid.toFixed(2)} paid of £${m.hire_value.toFixed(2)})`);
      } else {
        moneyLines.push(`<strong>Hire fee:</strong> £${m.hire_value.toFixed(2)} paid in full ✓`);
      }
    } else {
      moneyLines.push(`<strong>Hire fee:</strong> £${m.hire_value.toFixed(2)} (cached — ⚠ live HireHop balance unavailable, please verify)`);
    }
  }
  // Excess line: only show when self-drive (avoid "no excess required" noise
  // on backline-only / staging-only hires).
  if (b.job.has_self_drive) {
    if (m.excess_required > 0) {
      if (m.excess_outstanding > 0) {
        moneyLines.push(`<strong>Excess:</strong> £${m.excess_outstanding.toFixed(0)} outstanding (£${m.excess_taken.toFixed(0)} of £${m.excess_required.toFixed(0)} taken)`);
      } else {
        moneyLines.push(`<strong>Excess:</strong> £${m.excess_required.toFixed(0)} fully collected ✓`);
      }
    }
  }

  // Drivers section: only show for self-drive hires. Otherwise "No drivers
  // linked yet" is just noise on backline-only jobs.
  const showDrivers = b.job.has_self_drive;
  const driverRows = b.drivers.length === 0
    ? '<em style="color:#94a3b8;">No drivers linked yet.</em>'
    : b.drivers.map(renderDriver).join('');

  // Crew section: show when there are crew, or when transport quotes
  // exist (so staff can spot "we need crew here"). Hide if neither.
  const showCrew = b.crew.length > 0 || b.transport.some(t => t.crew_count === 0 || ['delivery', 'collection', 'crewed'].includes(t.job_type));
  const crewRows = b.crew.length === 0
    ? '<em style="color:#94a3b8;">No crew assigned.</em>'
    : b.crew.map(renderCrew).join('');

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="padding:14px 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
          <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#475569;font-weight:600;">Money</p>
          <ul style="margin:0 0 12px;padding-left:18px;font-size:13px;color:#1e293b;line-height:1.6;">
            ${moneyLines.map(l => `<li>${l}</li>`).join('')}
          </ul>
          ${showDrivers ? `
            <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#475569;font-weight:600;">Drivers</p>
            <div style="font-size:13px;color:#1e293b;line-height:1.6;margin-bottom:10px;">${driverRows}</div>
          ` : ''}
          ${showCrew ? `
            <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#475569;font-weight:600;">Crew</p>
            <div style="font-size:13px;color:#1e293b;line-height:1.6;">${crewRows}</div>
          ` : ''}
        </td>
      </tr>
    </table>
  `;
}

function renderContacts(b: JobBriefing): string {
  if (!b.contacts || b.contacts.length === 0) return '';
  // Render a To: row staff can copy: "Name <email>, Name <email>".
  // Email-only fallback for contacts with no name. Each contact also
  // listed below with its source label for trust/audit.
  const toLine = b.contacts
    .map(c => c.name && c.name.trim() ? `${c.name.trim()} <${c.email}>` : c.email)
    .join(', ');
  const sourceLabel: Record<string, string> = {
    'client_org': 'Client org email',
    'client_org_people': 'Client org person',
    'job_org_people': 'Linked org person',
    'job_org': 'Linked org email',
    'name_match': 'HH contact-name match',
  };
  const rows = b.contacts.map(c => {
    const label = sourceLabel[c.source] || c.source;
    return `<li style="margin:0 0 3px;"><strong>${escapeHtml(c.name || '—')}</strong> &lt;${escapeHtml(c.email)}&gt; <span style="color:#94a3b8;font-size:11px;">— ${escapeHtml(label)}</span></li>`;
  }).join('');
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="padding:14px 18px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#075985;font-weight:700;">
            ✉️ Contacts (copy into To: field)
          </p>
          <div style="padding:8px 12px;background:#fff;border:1px solid #e0f2fe;border-radius:6px;font-size:13px;color:#0f172a;margin-bottom:8px;word-break:break-word;">
            ${escapeHtml(toLine)}
          </div>
          <ul style="margin:0;padding-left:18px;font-size:12px;color:#475569;line-height:1.5;">
            ${rows}
          </ul>
        </td>
      </tr>
    </table>
  `;
}

function renderDriver(d: BriefingDriver): string {
  const formMap: Record<string, string> = {
    received: '✓ form received',
    sent: '⏳ form sent, awaiting',
    pending: '✗ no form yet',
  };
  const formColor: Record<string, string> = {
    received: '#15803d',
    sent: '#a16207',
    pending: '#b91c1c',
  };
  const referralBadge = d.referral_status === 'pending'
    ? ` <span style="color:#b45309;font-weight:600;">[REFERRAL PENDING]</span>`
    : '';
  const reg = d.vehicle_reg ? ` (${escapeHtml(d.vehicle_reg)})` : '';
  // Surface sent-to-email + date when status is 'sent' so staff can see
  // exactly what we asked for and from whom.
  const sentMeta = d.hire_form_status === 'sent' && d.hire_form_emailed_at
    ? ` <span style="color:#64748b;font-size:12px;">— sent to ${escapeHtml(d.hire_form_emailed_to || '?')} on ${escapeHtml(formatShortDate(d.hire_form_emailed_at))}</span>`
    : '';
  return `<div>${escapeHtml(d.name)}${reg} — <span style="color:${formColor[d.hire_form_status]};font-weight:600;">${formMap[d.hire_form_status]}</span>${referralBadge}${sentMeta}</div>`;
}

function renderCrew(c: BriefingCrew): string {
  const tag = c.is_ooosh_crew ? '[Ooosh]' : c.is_freelancer ? '[Freelancer]' : '[Crew]';
  const statusColor = c.status === 'confirmed' ? '#15803d'
    : c.status === 'declined' ? '#b91c1c'
    : '#a16207';
  return `<div>${escapeHtml(tag)} ${escapeHtml(c.name)} — ${escapeHtml(c.role)} — <span style="color:${statusColor};font-weight:600;">${escapeHtml(c.status)}</span></div>`;
}

function renderDiscussionPoints(b: JobBriefing): string {
  if (b.discussion_points.length === 0) return '';
  const items = b.discussion_points.map(p => `<li style="margin:0 0 4px;">${escapeHtml(p)}</li>`).join('');
  return `
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">
      Worth discussing with the client
    </p>
    <ul style="margin:0 0 20px;padding-left:20px;font-size:14px;color:#334155;line-height:1.6;">
      ${items}
    </ul>
  `;
}

function renderLastInteraction(b: JobBriefing): string {
  if (!b.last_interaction) {
    return `
      <p style="margin:0 0 20px;font-size:13px;color:#b91c1c;background:#fef2f2;padding:10px 14px;border-radius:8px;border:1px solid #fecaca;">
        <strong>No client interaction logged on this job.</strong> Worth touching base.
      </p>
    `;
  }
  const i = b.last_interaction;
  const ageColor = i.days_ago >= 7 ? '#a16207' : '#475569';
  return `
    <p style="margin:0 0 20px;font-size:13px;color:${ageColor};">
      <strong>Last contact:</strong> ${escapeHtml(i.type)} ${escapeHtml(i.days_ago === 0 ? 'today' : i.days_ago === 1 ? 'yesterday' : `${i.days_ago}d ago`)}${i.created_by_name ? ` by ${escapeHtml(i.created_by_name)}` : ''}
      ${i.content ? `<br><em style="color:#64748b;">"${escapeHtml(i.content)}"</em>` : ''}
    </p>
  `;
}

/**
 * Build the client-facing draft message.
 *
 * Uses jon's actual sent-email patterns as the model. Conditional
 * paragraphs based on:
 *   - Whether transport is delivering (no "what time would you collect?")
 *   - Default pickup time (ask for time)
 *   - Live balance position (paid in full / deposit + balance / TBC)
 *   - Hire form status per driver (sent / received / pending)
 *   - Excess outstanding
 */
function buildClientDraft(b: JobBriefing): string {
  const greeting = b.job.client_name?.split(' ')[0] || 'there';
  const startDay = b.job.out_date || b.job.job_date;
  const startDayLabel = formatFriendlyDate(startDay);
  const ref = b.job.hh_job_number ? `#${b.job.hh_job_number}` : 'your hire';
  // What's actually on the hire (van+backline / backline / staging / etc.)
  // Used in the delivery verb so backline-only jobs don't say "the van and
  // backline". Falls back to "the hire" generic if flags are unknown.
  const equipment = b.job.equipment_summary || 'the hire';

  const paragraphs: string[] = [];

  paragraphs.push(`Hi ${greeting},`);
  paragraphs.push(`Hope you're well. Just checking in re your hire ${ref}, which starts on ${startDayLabel}.`);

  // Transport delivery vs collection-time-ask vs known-time
  const deliveryQuotes = b.transport.filter(t => t.job_type === 'delivery' || t.job_type === 'crewed');
  const collectionQuotes = b.transport.filter(t => t.job_type === 'collection');

  if (deliveryQuotes.length > 0) {
    const lines: string[] = [];
    for (const d of deliveryQuotes) {
      const venue = d.venue || 'the venue';
      const when = d.job_date && d.arrival_time
        ? `at ${formatTime(d.arrival_time)} on ${formatFriendlyDate(d.job_date)}`
        : d.arrival_time
          ? `at ${formatTime(d.arrival_time)}`
          : d.job_date
            ? `on ${formatFriendlyDate(d.job_date)}`
            : '';
      const verb = d.job_type === 'crewed'
        ? "We'll be on site at"
        : `We're delivering ${equipment} to`;
      lines.push(`${verb} ${venue}${when ? ' ' + when : ''} - please can you confirm the name and number of who we're meeting there?`);
    }
    paragraphs.push(lines.join(' '));
  } else if (b.job.is_default_pickup_time) {
    paragraphs.push(`Do you have a collection time in mind?`);
  }

  // Collection paragraph — note this changes the end-of-hire framing
  // (we're picking up, not them returning). Detected below.
  if (collectionQuotes.length > 0) {
    for (const c of collectionQuotes) {
      const venue = c.venue || 'the venue';
      const when = c.job_date ? ` on ${formatFriendlyDate(c.job_date)}${c.arrival_time ? ` at ${formatTime(c.arrival_time)}` : ''}` : '';
      paragraphs.push(`We'll be picking up from ${venue}${when}.`);
    }
  }

  // End-of-hire reference — uses job_end (the inside / real end date).
  // Skip when we're collecting (the collection paragraph already covers
  // it) so we don't tell the client to "return it to us" when we're
  // physically picking up.
  if (collectionQuotes.length === 0) {
    const returnRef = b.job.job_end || b.job.return_date;
    if (returnRef) {
      paragraphs.push(`To confirm the hire must be returned to us by 9am on ${formatShortDate(returnRef)}.`);
    }
  }

  // Money paragraph — built from two independent halves (hire fee + excess)
  // so the joining language matches their actual statuses. The previous
  // implementation joined "Hire fee paid in full, thanks" with "along with
  // the insurance excess of £1200" using a comma — which read as if the
  // excess was ALSO paid in full. Now: when one is settled and the other
  // outstanding, use two separate sentences. When both outstanding, join
  // with "along with" so it's a single payment ask.
  if (b.money.hh_billing_loaded) {
    const m = b.money;
    const hireFeeApplies = m.hire_value > 0;
    const hireFeeOutstanding = hireFeeApplies && m.balance_outstanding > 0;
    const excessOutstanding = m.excess_outstanding > 0;

    // Build the hire fee clause (or null if no hire fee on the job).
    let hireFeeClause: string | null = null;
    if (hireFeeApplies) {
      if (hireFeeOutstanding) {
        hireFeeClause = m.deposits_paid > 0
          ? `You've paid £${m.deposits_paid.toFixed(2)} so far, leaving a balance of £${m.balance_outstanding.toFixed(2)} due before the hire`
          : `Hire fee of £${m.hire_value.toFixed(2)} is still to be paid before the hire`;
      } else {
        hireFeeClause = `Hire fee of £${m.hire_value.toFixed(2)} is paid in full, thanks`;
      }
    }

    const paymentLink = 'Payment options through the blue link at the bottom of the quote.';

    if (hireFeeOutstanding && excessOutstanding) {
      // Both due — single payment ask.
      paragraphs.push(
        `${hireFeeClause}, along with the insurance excess of £${m.excess_outstanding.toFixed(0)}. ${paymentLink}`
      );
    } else if (hireFeeOutstanding) {
      // Only hire fee due.
      paragraphs.push(`${hireFeeClause}. ${paymentLink}`);
    } else if (excessOutstanding) {
      // Hire fee settled (or n/a), excess still to collect — two sentences
      // so "paid in full" doesn't bleed into the excess line.
      if (hireFeeClause) {
        paragraphs.push(
          `${hireFeeClause}. We still need to collect the insurance excess of £${m.excess_outstanding.toFixed(0)} before the hire — ${paymentLink.charAt(0).toLowerCase() + paymentLink.slice(1)}`
        );
      } else {
        paragraphs.push(
          `Insurance excess of £${m.excess_outstanding.toFixed(0)} still to be collected before the hire. ${paymentLink}`
        );
      }
    } else if (hireFeeClause) {
      // Everything settled — short positive sentence, no payment link.
      paragraphs.push(`${hireFeeClause}.`);
    }
  }
  // If HH billing didn't load, leave the money paragraph out — the
  // briefing's red-flag panel + discussion points tell staff to fill in
  // the balance position themselves before sending. Better than auto-
  // stating a stale or wrong number.

  // Hire form status — per-driver. Only relevant for self-drive hires;
  // backline-only / D&C jobs don't have drivers and shouldn't see this.
  //
  // Across all "still waiting" branches we never ask the client for driver
  // names + contact details — that's the wrong ask: we just need them to
  // fill in the form. Instead we always surface the hire-form link
  // (https://hireforms.oooshtours.co.uk/?job=<n>) and, where we've already
  // sent it via the auto-emailer, reference the send so the client knows
  // we've already reached out.
  if (b.job.has_self_drive) {
    const driversReceived = b.drivers.filter(d => d.hire_form_status === 'received');
    const driversSent = b.drivers.filter(d => d.hire_form_status === 'sent');
    const driversPending = b.drivers.filter(d => d.hire_form_status === 'pending');
    const totalDrivers = b.drivers.length;
    const link = b.hire_form_link;
    const linkSuffix = link ? ` Here's the link: ${link.url}` : '';

    if (totalDrivers > 0) {
      if (driversReceived.length === totalDrivers) {
        // All in — no need to re-share the link (the form journey is done).
        paragraphs.push(`We've received hire form${pluralise(totalDrivers, '')} from ${driversReceived.map(d => d.name).join(', ')}, all approved. Please let us know if any other drivers will be on the hire so we can get their details too.`);
      } else if (driversReceived.length > 0 && (driversSent.length > 0 || driversPending.length > 0)) {
        const stillNeeded = [...driversSent, ...driversPending].map(d => d.name).join(', ');
        paragraphs.push(`We've received hire form${pluralise(driversReceived.length, '')} from ${driversReceived.map(d => d.name).join(', ')} so far. Still waiting on ${stillNeeded} — please could they fill in the hire form when they get a moment?${linkSuffix}`);
      } else if (driversSent.length > 0) {
        const sentTo = driversSent
          .filter(d => d.hire_form_emailed_to)
          .map(d => `${d.hire_form_emailed_to}${d.hire_form_emailed_at ? ` on ${formatShortDate(d.hire_form_emailed_at)}` : ''}`)
          .join(' and ');
        const recipientPart = sentTo ? ` (sent to ${sentTo})` : '';
        paragraphs.push(`We've sent the hire form link${recipientPart} but haven't had ${pluralise(driversSent.length, 'it', 'them')} back yet — could you confirm receipt? Worth getting these in asap in case of any referrals.${linkSuffix}`);
      } else {
        paragraphs.push(`We don't have any hire forms in yet — please could each driver fill in the hire form when they get a moment?${linkSuffix}`);
      }
    } else {
      // Self-drive hire but no drivers linked yet. The auto-emailer should
      // have sent the link to the client contacts ~10 days out — reference
      // that send when we have a record of it, otherwise just give them
      // the link with a light prompt.
      if (link && link.last_sent_at && link.last_sent_to) {
        const noun = link.last_send_was_reminder ? 'reminder' : 'link';
        paragraphs.push(`We've already sent the hire form ${noun} to ${link.last_sent_to} on ${formatShortDate(link.last_sent_at)} — could you confirm you've received it? In case it's useful, here's the link again: ${link.url}`);
      } else if (link) {
        paragraphs.push(`Please could each driver fill in our hire form when they get a moment: ${link.url}`);
      } else {
        // No HH job number, no link to share. Fallback ask — but still
        // not asking for names + contact details, which would put the
        // admin overhead back on us.
        paragraphs.push(`Please could each driver fill in our hire form when they get a moment? Let me know if you need me to resend the link.`);
      }
    }
  }

  // Closing — quote attachment + invitation to ask
  paragraphs.push(`Lastly, please see attached a copy of the latest pick list / quote. Please can you confirm that everything is as you are expecting? And of course, if you have any questions for us in the meantime, do please let me know.`);
  paragraphs.push(`Look forward to hearing back from you.`);
  paragraphs.push(`Many thanks,`);

  return paragraphs.join('\n\n');
}

function renderClientEmailDraft(b: JobBriefing): string {
  const draftPlain = buildClientDraft(b);
  // Render as paragraphs in the body's normal font (NOT <pre>, no monospace).
  // Triple-click selects a paragraph, Ctrl+A selects everything inside the
  // surrounding <td> when focused. Yellow background keeps it visually
  // distinct as "the draft".
  const paragraphs = draftPlain.split(/\n\n+/);
  const paragraphHtml = paragraphs
    .map(p => `<p style="margin:0 0 12px;font-size:14px;color:#1e293b;line-height:1.55;white-space:pre-wrap;">${escapeHtml(p)}</p>`)
    .join('');
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="padding:14px 18px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;">
          <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#92400e;font-weight:700;">
            ✉️ Suggested message to the client
          </p>
          <p style="margin:0 0 12px;font-size:11px;color:#a16207;">
            Triple-click a paragraph (or Ctrl+A inside the box) to select, then paste into your reply. Edit as you see fit.
          </p>
          <div style="padding:14px 16px;background:#fff;border:1px solid #fef3c7;border-radius:8px;">
            ${paragraphHtml}
          </div>
        </td>
      </tr>
    </table>
  `;
}

function renderLinks(b: JobBriefing): string {
  const links: string[] = [];
  links.push(`<a href="${escapeHtml(b.links.job_detail)}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">Open job in OP →</a>`);
  if (b.links.hirehop) {
    links.push(`<a href="${escapeHtml(b.links.hirehop)}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">HireHop →</a>`);
  }
  return `
    <p style="margin:20px 0 0;font-size:13px;color:#475569;line-height:1.8;">
      ${links.join(' &nbsp;·&nbsp; ')}
    </p>
  `;
}

// ── Main render ─────────────────────────────────────────────────────────

export function renderBriefingHtml(b: JobBriefing): string {
  return `
    ${renderHeader(b)}
    ${renderRedFlags(b.red_flags)}
    ${renderProgressStrip(b.progress_strip)}
    ${renderOutstanding(b)}
    ${renderTransportSummary(b)}
    ${renderMoneyAndPeople(b)}
    ${renderLastInteraction(b)}
    ${renderDiscussionPoints(b)}
    ${renderContacts(b)}
    ${renderClientEmailDraft(b)}
    ${renderLinks(b)}
  `;
}
