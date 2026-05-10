/**
 * Pre-Hire Briefing email rendering.
 *
 * Internal email — goes to info@oooshtours.co.uk every morning at 10am for
 * each confirmed job approaching its hire date. Replaces the Monday.com
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

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
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
  const startBits = [formatDate(b.job.out_date || b.job.job_date)];
  if (b.job.out_time) startBits.push(formatTime(b.job.out_time));
  const endBits = [formatDate(b.job.return_date || b.job.job_end)];
  if (b.job.return_time) endBits.push(formatTime(b.job.return_time));
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

function renderMoneyAndPeople(b: JobBriefing): string {
  const m = b.money;
  const moneyLines: string[] = [];
  if (m.hire_value > 0) moneyLines.push(`<strong>Hire fee:</strong> £${m.hire_value.toFixed(2)} (check HireHop for current balance)`);
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
  return `<div>${escapeHtml(d.name)}${reg} — <span style="color:${formColor[d.hire_form_status]};font-weight:600;">${formMap[d.hire_form_status]}</span>${referralBadge}</div>`;
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

function renderClientEmailDraft(b: JobBriefing): string {
  const greeting = b.job.client_name?.split(' ')[0] || 'there';
  const startDay = b.job.out_date || b.job.job_date;
  const startDayLabel = startDay
    ? new Date(startDay).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    : 'soon';

  // Build conditional sentences from briefing data
  const bullets: string[] = [];
  const driversNeedingForm = b.drivers.filter(d => d.hire_form_status !== 'received');
  if (driversNeedingForm.length > 0) {
    bullets.push(`We're still waiting on hire form${driversNeedingForm.length === 1 ? '' : 's'} from ${driversNeedingForm.map(d => d.name).join(', ')}. The link is the same one used previously — let me know if you need it sent again.`);
  }
  if (b.money.excess_outstanding > 0) {
    bullets.push(`Insurance excess of £${b.money.excess_outstanding.toFixed(0)} still to be collected before the hire begins.`);
  }
  if (b.money.hire_value > 0) {
    bullets.push(`Quick check on the balance for the hire fee — please confirm payment is in train.`);
  }
  const introsTodo = b.transport.filter(t => t.client_intro_status === 'todo' || t.client_intro_status === 'working_on_it');
  if (introsTodo.length > 0) {
    bullets.push(`Have we introduced you to the driver(s) yet? Happy to make that intro now if not.`);
  }

  const returnLine = (b.job.return_date || b.job.job_end)
    ? `\nThe hire is back with us by ${formatDate(b.job.return_date || b.job.job_end)}.`
    : '';

  const ref = b.job.hh_job_number ? `#${b.job.hh_job_number}` : 'your hire';

  // Plain text — staff copy-pastes into a fresh email. Do NOT HTML-escape
  // the body since they'll paste it into their own email client which
  // expects plain text.
  const draftPlain = `Hi ${greeting},

Hope you're well. Just checking in re ${ref}, which starts on ${startDayLabel}.${returnLine}

${bullets.length > 0
    ? bullets.map(b => `- ${b}`).join('\n')
    : 'Everything looks in good shape from our end — just touching base ahead of the hire.'}

Lastly, if you have any questions for us in the meantime, do please let me know.

Look forward to hearing back from you.

Many thanks,`;

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="padding:14px 18px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;">
          <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#92400e;font-weight:700;">
            ✉️ Copy-paste this to the client
          </p>
          <p style="margin:0 0 8px;font-size:11px;color:#a16207;">
            Edit as you see fit, then send from your own inbox. This is a starting point only.
          </p>
          <pre style="margin:0;padding:12px 14px;background:#fff;border:1px solid #fef3c7;border-radius:8px;font-family:Menlo,Monaco,Consolas,monospace;font-size:12.5px;line-height:1.5;color:#1e293b;white-space:pre-wrap;word-wrap:break-word;">${escapeHtml(draftPlain)}</pre>
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
    ${renderMoneyAndPeople(b)}
    ${renderLastInteraction(b)}
    ${renderDiscussionPoints(b)}
    ${renderClientEmailDraft(b)}
    ${renderLinks(b)}
  `;
}
