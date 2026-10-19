/**
 * PCN "needs attention" — the shared classification used by BOTH the dashboard
 * NeedsAttention buckets (Step 8, passive surface) and the daily deadline/NIP
 * nudge scheduler (Step 6, active info@ alerts), so the two can never disagree.
 *
 * Four buckets:
 *   nip_urgent          🔴 police NIP, still unactioned — 28-day legal window
 *   ready_to_transfer   🔴 pay-direct lapsed past the final receipt chase, no proof
 *   deadline_approaching 🔴 issuer reduced/final deadline near, still unactioned
 *   awaiting_action     🟡 logged (received), no path chosen, nothing imminent
 *
 * All nudges from here are INTERNAL (info@ + the bell-less dashboard) — they
 * never email a client, so historical/imported PCNs can't trigger a client
 * flurry even while open.
 */
import { query } from '../config/database';
import { getSystemSettings } from '../routes/system-settings';
import { emailService } from '../services/email-service';
import { getFrontendUrl } from '../config/app-urls';

const OOOSH_EMAIL = 'info@oooshtours.co.uk';
const POLICE_NIP_DAYS = 28; // statutory keeper-response window

// Lightweight row for display + nudge — enough to render a card / compose an alert.
const SELECT_ATTENTION = `
  SELECT p.id, p.reference, p.fine_type, p.status, p.hh_job_number,
         COALESCE(fv.reg, p.vehicle_reg) AS reg,
         p.reduced_deadline, p.final_deadline, p.offence_at,
         p.receipt_chase_level, p.deadline_nudge_sent_for,
         COALESCE(p.reduced_deadline, p.final_deadline) AS issuer_deadline
  FROM pcns p
  LEFT JOIN fleet_vehicles fv ON fv.id = p.vehicle_id
`;

export interface PcnAttentionRow {
  id: string;
  reference: string | null;
  fine_type: string;
  status: string;
  hh_job_number: number | null;
  reg: string | null;
  reduced_deadline: string | null;
  final_deadline: string | null;
  offence_at: string | null;
  issuer_deadline: string | null;
  receipt_chase_level: number | null;
  deadline_nudge_sent_for: string | null;
}

export interface PcnAttentionBuckets {
  nip_urgent: PcnAttentionRow[];
  ready_to_transfer: PcnAttentionRow[];
  deadline_approaching: PcnAttentionRow[];
  awaiting_action: PcnAttentionRow[];
}

async function warningDays(): Promise<number> {
  const s = await getSystemSettings(['pcn_deadline_warning_days']);
  const n = parseInt(s.pcn_deadline_warning_days || '7', 10);
  return isNaN(n) ? 7 : n;
}

export async function getPcnAttentionBuckets(): Promise<PcnAttentionBuckets> {
  const win = await warningDays();
  const [nip, transfer, deadline, awaiting] = await Promise.all([
    query(
      `${SELECT_ATTENTION}
       WHERE p.is_deleted = false AND p.fine_type = 'police_nip'
         AND p.status IN ('received', 'awaiting_driver_id')
       ORDER BY p.offence_at ASC NULLS LAST LIMIT 25`,
    ),
    query(
      `${SELECT_ATTENTION}
       WHERE p.is_deleted = false AND p.status = 'driver_notified_pay'
         AND p.receipt_url IS NULL AND COALESCE(p.receipt_chase_level, 0) >= 3
       ORDER BY p.pay_direct_deadline ASC NULLS LAST LIMIT 25`,
    ),
    query(
      `${SELECT_ATTENTION}
       WHERE p.is_deleted = false AND p.fine_type <> 'police_nip'
         AND p.status IN ('received', 'awaiting_driver_id')
         AND COALESCE(p.reduced_deadline, p.final_deadline) IS NOT NULL
         AND COALESCE(p.reduced_deadline, p.final_deadline)
             BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
       ORDER BY COALESCE(p.reduced_deadline, p.final_deadline) ASC LIMIT 25`,
      [String(win)],
    ),
    query(
      `${SELECT_ATTENTION}
       WHERE p.is_deleted = false AND p.status = 'received' AND p.fine_type <> 'police_nip'
         AND (COALESCE(p.reduced_deadline, p.final_deadline) IS NULL
              OR COALESCE(p.reduced_deadline, p.final_deadline) > CURRENT_DATE + ($1 || ' days')::interval
              OR COALESCE(p.reduced_deadline, p.final_deadline) < CURRENT_DATE)
       ORDER BY p.created_at DESC LIMIT 25`,
      [String(win)],
    ),
  ]);
  return {
    nip_urgent: nip.rows as PcnAttentionRow[],
    ready_to_transfer: transfer.rows as PcnAttentionRow[],
    deadline_approaching: deadline.rows as PcnAttentionRow[],
    awaiting_action: awaiting.rows as PcnAttentionRow[],
  };
}

const fmtDate = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('en-GB') : '—');

function nipDaysRemaining(offenceAt: string | null): number | null {
  if (!offenceAt) return null;
  const elapsed = Math.floor((Date.now() - new Date(offenceAt).getTime()) / 86_400_000);
  return POLICE_NIP_DAYS - elapsed;
}

/**
 * Daily scan: fire an internal (info@) nudge for NIP-urgent + deadline-approaching
 * PCNs that haven't been nudged for the current deadline. Stamp-first dedup via
 * `deadline_nudge_sent_for` so a transient send failure doesn't double-fire and
 * a changed deadline re-nudges. NO client emails.
 */
export async function runPcnDeadlineNudges(): Promise<{ nudged: number }> {
  const buckets = await getPcnAttentionBuckets();
  let nudged = 0;

  // NIP — dedup key 'nip' (one alert per notice; the 28-day clock is the urgency).
  for (const p of buckets.nip_urgent) {
    if (p.deadline_nudge_sent_for === 'nip') continue;
    const days = nipDaysRemaining(p.offence_at);
    await query(`UPDATE pcns SET deadline_nudge_sent_for = 'nip', updated_at = NOW() WHERE id = $1`, [p.id]);
    await sendDeadlineAlert(p, true,
      days != null ? (days <= 0 ? 'response window has passed' : `${days} day(s) left in the 28-day window`) : 'respond as soon as possible');
    nudged += 1;
  }

  // Issuer deadline — dedup key = the deadline date, so it re-fires if the date moves.
  for (const p of buckets.deadline_approaching) {
    const key = p.issuer_deadline ? String(p.issuer_deadline).slice(0, 10) : null;
    if (!key || p.deadline_nudge_sent_for === key) continue;
    await query(`UPDATE pcns SET deadline_nudge_sent_for = $2, updated_at = NOW() WHERE id = $1`, [p.id, key]);
    await sendDeadlineAlert(p, false, `deadline ${fmtDate(p.issuer_deadline)}`);
    nudged += 1;
  }

  return { nudged };
}

async function sendDeadlineAlert(p: PcnAttentionRow, urgent: boolean, deadlineLabel: string): Promise<void> {
  const reg = p.reg || '—';
  const ref = p.reference || '—';
  const subjectLine = urgent
    ? `URGENT: Police NIP unactioned — ${reg} (${ref})`
    : `PCN deadline approaching — ${reg} (${ref})`;
  try {
    await emailService.send('pcn_deadline_alert', {
      to: OOOSH_EMAIL,
      variables: {
        subjectLine,
        urgent: urgent ? 'yes' : '',
        vehicleReg: reg,
        pcnReference: ref,
        deadlineLabel,
        statusLabel: p.status.replace(/_/g, ' '),
        pcnUrl: `${getFrontendUrl()}/vehicles/pcns/${p.id}`,
      },
    });
  } catch (err) {
    console.error('[pcn-attention] deadline alert send failed:', err);
  }
}
