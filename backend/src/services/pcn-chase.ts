/**
 * PCN pay-direct chase ladder.
 *
 * When a driver is told to pay a charge directly (action='pay_direct',
 * status='driver_notified_pay'), they get a 48h deadline + a tokenised
 * receipt-upload link. If no proof lands, this daily scan chases them on a
 * configurable ladder (default 3/5/7 days past the deadline), re-sending the
 * pay-direct email (same upload link) and alerting info@ at EVERY rung — the
 * pay-direct path has to be rock-solid (jon), so a human always sees the chase.
 * On the final rung it flags the PCN for one-click escalation to liability
 * transfer.
 *
 * Idempotent: `receipt_chase_level` tracks rungs sent; `receipt_chase_sent_for`
 * is a per-day stamp so a second run on the same day is a no-op. Receipt upload
 * flips status → 'paid_by_driver', which drops the PCN out of this scan.
 */
import { query } from '../config/database';
import { emailService } from '../services/email-service';
import { getSystemSettings } from '../routes/system-settings';
import { resolveClientEmailTarget } from '../services/money-emails';
import { getFromR2 } from '../config/r2';
import { getFrontendUrl } from '../config/app-urls';

const OOOSH_EMAIL = 'info@oooshtours.co.uk';
const OOOSH_PHONE = '+44 1273 911382';
const fmtDate = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('en-GB') : '—');
const money = (n: unknown) => (n == null ? null : `£${Number(n).toFixed(2)}`);
const DAY_MS = 86_400_000;

export async function runPcnChases(): Promise<{ chased: number; escalations: number }> {
  const settings = await getSystemSettings(['pcn_receipt_chase_days', 'pcn_handling_charge']);
  const chaseDays = (settings.pcn_receipt_chase_days || '3,5,7')
    .split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  if (chaseDays.length === 0) return { chased: 0, escalations: 0 };
  const handlingFee = money(parseFloat(settings.pcn_handling_charge || '35')) || '£35';
  const today = new Date().toISOString().slice(0, 10);

  const r = await query(
    `SELECT p.*, fv.reg AS fleet_reg, d.full_name AS driver_name, d.email AS driver_email
     FROM pcns p
     LEFT JOIN fleet_vehicles fv ON fv.id = p.vehicle_id
     LEFT JOIN drivers d ON d.id = p.driver_id
     WHERE p.status = 'driver_notified_pay'
       AND p.receipt_url IS NULL
       AND p.is_deleted = false
       AND p.pay_direct_deadline IS NOT NULL`,
    []
  );

  let chased = 0;
  let escalations = 0;

  for (const pcn of r.rows) {
    if (pcn.receipt_chase_sent_for === today) continue;  // already ran today

    const daysSinceDeadline = Math.floor((Date.now() - new Date(pcn.pay_direct_deadline).getTime()) / DAY_MS);
    // How many ladder thresholds have we crossed?
    const targetLevel = chaseDays.filter((d) => daysSinceDeadline >= d).length;
    if (targetLevel === 0) continue;                       // still within grace
    if ((pcn.receipt_chase_level || 0) >= targetLevel) continue;  // rung already sent

    const isFinal = targetLevel >= chaseDays.length;
    const ok = await sendChase(pcn, handlingFee);

    // Stamp first regardless of email success (avoid re-spamming on a flaky send;
    // matches the sanity-scanner stamp-first convention).
    await query(
      `UPDATE pcns SET receipt_chase_level = $2, receipt_chase_sent_for = $3, updated_at = NOW() WHERE id = $1`,
      [pcn.id, targetLevel, today]
    );
    await query(
      `INSERT INTO pcn_events (pcn_id, event_type, body) VALUES ($1, 'receipt_chase', $2)`,
      [pcn.id, `Chase ${targetLevel}/${chaseDays.length} sent (${daysSinceDeadline}d past deadline)${ok ? '' : ' — client email failed'}${isFinal ? ' · FINAL — escalation suggested' : ''}`]
    );

    // info@ alert every rung (+ escalation flag on the last)
    await alertInfo(pcn, targetLevel, chaseDays.length, isFinal, daysSinceDeadline).catch((e) =>
      console.error('[pcn-chase] info alert failed:', e)
    );

    chased++;
    if (isFinal) escalations++;
  }

  return { chased, escalations };
}

// Re-send the pay-direct email (carries the existing upload token link).
async function sendChase(pcn: Record<string, unknown>, handlingFee: string): Promise<boolean> {
  try {
    let to: string | null = (pcn.driver_email as string) || null;
    let cc: string[] = [];
    if (!to && pcn.job_id) {
      const tgt = await resolveClientEmailTarget(pcn.job_id as string, 'pcn_pay_direct');
      to = tgt.primaryEmail;
      cc = tgt.ccEmails || [];
    }
    if (!to) return false;  // nobody to chase — the info@ alert still fires

    const receiptUploadUrl = pcn.receipt_upload_token
      ? `${getFrontendUrl()}/pcn-receipt/${pcn.receipt_upload_token}`
      : '';
    const reduced = money(pcn.reduced_amount);
    const fineLine = money(pcn.fine_amount)
      ? `${money(pcn.fine_amount)}${reduced ? ` (${reduced} if paid by ${fmtDate(pcn.reduced_deadline)})` : ''}`
      : '—';

    // Notice attachment (best-effort)
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    if (pcn.pcn_document_url) {
      try {
        const obj = await getFromR2(pcn.pcn_document_url as string);
        const bytes = await (obj.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
        const isPdf = String(pcn.pcn_document_url).toLowerCase().endsWith('.pdf');
        attachments.push({
          filename: `PCN-${pcn.vehicle_reg || 'notice'}-${pcn.reference || ''}.${isPdf ? 'pdf' : 'jpg'}`.replace(/\s/g, ''),
          content: Buffer.from(bytes),
          contentType: isPdf ? 'application/pdf' : 'image/jpeg',
        });
      } catch { /* best-effort */ }
    }

    const jobRefSentence = pcn.hh_job_number ? ` (our ref #${pcn.hh_job_number})` : '';
    await emailService.send('pcn_pay_direct', {
      to,
      cc: cc.length ? cc : undefined,
      attachments: attachments.length ? attachments : undefined,
      variables: {
        driverName: (pcn.driver_name as string) || 'Sir/Madam',
        clientName: (pcn.client_organisation_name as string) || 'Sir/Madam',
        vehicleReg: (pcn.fleet_reg as string) || (pcn.vehicle_reg as string) || '—',
        pcnReference: (pcn.reference as string) || '—',
        issuer: (pcn.issuing_authority as string) || '—',
        offenceDateTime: `${fmtDate(pcn.offence_at)}${pcn.offence_time_text ? ` ${pcn.offence_time_text}` : ''}`,
        offenceDate: fmtDate(pcn.offence_at),
        location: (pcn.location as string) || '—',
        fineLine,
        finalDeadline: fmtDate(pcn.final_deadline),
        handlingFee,
        handlingSentence: '',
        driverListSentence: '',
        jobRef: pcn.hh_job_number ? `#${pcn.hh_job_number}` : '',
        jobRefSentence,
        receiptUploadUrl,
        oooshEmail: OOOSH_EMAIL,
        oooshPhone: OOOSH_PHONE,
      },
    });
    return true;
  } catch (err) {
    console.error('[pcn-chase] client chase send failed:', err);
    return false;
  }
}

async function alertInfo(
  pcn: Record<string, unknown>, level: number, total: number, escalate: boolean, daysPast: number
): Promise<void> {
  const reg = (pcn.fleet_reg as string) || (pcn.vehicle_reg as string) || '—';
  const ref = (pcn.reference as string) || '—';
  const subjectLine = escalate
    ? `PCN ESCALATION — ${reg} unpaid after final chase (${ref})`
    : `PCN chase ${level}/${total} sent — ${reg} (${ref})`;
  await emailService.send('pcn_chase_alert', {
    to: OOOSH_EMAIL,
    variables: {
      subjectLine,
      vehicleReg: reg,
      pcnReference: ref,
      driverName: (pcn.driver_name as string) || 'the driver',
      level: String(level),
      total: String(total),
      daysPast: String(daysPast),
      escalate: escalate ? 'yes' : '',
      pcnUrl: `${getFrontendUrl()}/vehicles/pcns/${pcn.id}`,
    },
  });
}
