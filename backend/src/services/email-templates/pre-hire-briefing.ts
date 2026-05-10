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
      moneyLines.push(`<strong>Hire fee:</strong> £${m.hire_value.toFixed(2)} (live HireHop balance unavailable — check HH)`);
    }
  }
  if (m.excess_required > 0) {
    if (m.excess_outstanding > 0) {
      moneyLines.push(`<strong>Excess:</strong> £${m.excess_outstanding.toFixed(0)} outstanding (£${m.excess_taken.toFixed(0)} of £${m.excess_required.toFixed(0)} taken)`);
    } else {
      moneyLines.push(`<strong>Excess:</strong> £${m.excess_required.toFixed(0)} fully collected ✓`);
    }
  } else {
    moneyLines.push(`<strong>Excess:</strong> none required (no self-drive)`);
  }

  const driverRows = b.drivers.length === 0
    ? '<em style="color:#94a3b8;">No drivers linked yet.</em>'
    : b.drivers.map(renderDriver).join('');

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
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#475569;font-weight:600;">Drivers</p>
          <div style="font-size:13px;color:#1e293b;line-height:1.6;margin-bottom:10px;">${driverRows}</div>
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#475569;font-weight:600;">Crew</p>
          <div style="font-size:13px;color:#1e293b;line-height:1.6;">${crewRows}</div>
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
      const verb = d.job_type === 'crewed' ? "We'll be on site at" : "We're delivering the van and backline to";
      lines.push(`${verb} ${venue}${when ? ' ' + when : ''} - please can you confirm the name and number of who we're meeting there?`);
    }
    paragraphs.push(lines.join(' '));
  } else if (b.job.is_default_pickup_time) {
    paragraphs.push(`Do you have a collection time in mind?`);
  }

  if (collectionQuotes.length > 0) {
    for (const c of collectionQuotes) {
      const venue = c.venue || 'the venue';
      const when = c.job_date ? ` on ${formatFriendlyDate(c.job_date)}${c.arrival_time ? ` at ${formatTime(c.arrival_time)}` : ''}` : '';
      paragraphs.push(`We'll be picking up from ${venue}${when}.`);
    }
  }

  // Return reference uses job_end (the inside / real end date), not return_date
  const returnRef = b.job.job_end || b.job.return_date;
  if (returnRef) {
    paragraphs.push(`To confirm the hire must be returned to us by 9am on ${formatShortDate(returnRef)}.`);
  }

  // Money paragraph — combines balance + excess
  const moneyBits: string[] = [];
  if (b.money.hh_billing_loaded && b.money.hire_value > 0) {
    if (b.money.balance_outstanding > 0) {
      const depositPart = b.money.deposits_paid > 0
        ? `You've paid £${b.money.deposits_paid.toFixed(2)} so far, leaving a balance of £${b.money.balance_outstanding.toFixed(2)} due before the hire`
        : `Hire fee of £${b.money.hire_value.toFixed(2)} is still to be paid before the hire`;
      moneyBits.push(depositPart);
    } else {
      moneyBits.push(`Hire fee of £${b.money.hire_value.toFixed(2)} is paid in full, thanks`);
    }
  }
  if (b.money.excess_outstanding > 0) {
    if (moneyBits.length > 0) {
      moneyBits.push(`along with the insurance excess of £${b.money.excess_outstanding.toFixed(0)}`);
    } else {
      moneyBits.push(`Insurance excess of £${b.money.excess_outstanding.toFixed(0)} still to be collected before the hire`);
    }
  }
  if (moneyBits.length > 0) {
    paragraphs.push(`${moneyBits.join(', ')}. Payment options through the blue link at the bottom of the quote.`);
  }

  // Hire form status — per-driver
  const driversReceived = b.drivers.filter(d => d.hire_form_status === 'received');
  const driversSent = b.drivers.filter(d => d.hire_form_status === 'sent');
  const driversPending = b.drivers.filter(d => d.hire_form_status === 'pending');
  const totalDrivers = b.drivers.length;
  if (totalDrivers > 0) {
    if (driversReceived.length === totalDrivers) {
      paragraphs.push(`We've received hire form${pluralise(totalDrivers, '')} from ${driversReceived.map(d => d.name).join(', ')}, all approved. Please let us know if any other drivers will be on the hire so we can get their details too.`);
    } else if (driversReceived.length > 0 && (driversSent.length > 0 || driversPending.length > 0)) {
      const stillNeeded = [...driversSent, ...driversPending].map(d => d.name).join(', ');
      paragraphs.push(`We've received hire form${pluralise(driversReceived.length, '')} from ${driversReceived.map(d => d.name).join(', ')} so far. Still waiting on ${stillNeeded} — happy to resend the link if needed.`);
    } else if (driversSent.length > 0) {
      const sentTo = driversSent
        .filter(d => d.hire_form_emailed_to)
        .map(d => `${d.hire_form_emailed_to}${d.hire_form_emailed_at ? ` on ${formatShortDate(d.hire_form_emailed_at)}` : ''}`)
        .join(' and ');
      const recipientPart = sentTo ? ` (sent to ${sentTo})` : '';
      paragraphs.push(`We've sent the hire form link${recipientPart} but haven't had ${pluralise(driversSent.length, 'it', 'them')} back yet — could you confirm receipt or let us know if you need ${pluralise(driversSent.length, 'it', 'them')} resent? Worth getting these in asap in case of any referrals.`);
    } else {
      paragraphs.push(`We don't have any hire forms in yet — let me know who'll be driving and I'll send the link across.`);
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
    ${renderClientEmailDraft(b)}
    ${renderLinks(b)}
  `;
}
