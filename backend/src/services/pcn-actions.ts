/**
 * PCN action paths — the "what next" after a PCN is logged.
 *
 * One entry point (`applyPcnAction`) drives status + action_path, the optional
 * client/driver email (branded, attaches the notice), and the optional HireHop
 * £35+VAT handling charge. Replaces the legacy Netlify send-email.js +
 * hirehop-charge.js action handlers.
 *
 * Recipient rule:
 *   - driver-facing actions (transfer_liability / pay_direct) → the matched
 *     driver's email, else the job's client contacts, else info@.
 *   - client-facing actions (request_driver_id / pay_recharge) → the job's
 *     client contacts, else info@.
 *   - an explicit email_override always wins.
 */
import { query } from '../config/database';
import { emailService } from '../services/email-service';
import { hhBroker } from '../services/hirehop-broker';
import { getFromR2 } from '../config/r2';
import { resolveClientEmailTarget } from '../services/money-emails';
import { getSystemSettings } from '../routes/system-settings';

const OOOSH_EMAIL = 'info@oooshtours.co.uk';
const OOOSH_PHONE = '+44 1273 911382';

export type PcnAction =
  | 'transfer_liability'
  | 'pay_direct'
  | 'pay_recharge'
  | 'request_driver_id'
  | 'internal_ooosh'
  | 'internal_freelancer'
  | 'query';

// action → (status, action_path, driver-facing?, charges-by-default?)
const ACTION_MAP: Record<PcnAction, {
  status: string; action_path: string | null; driverFacing: boolean; chargesByDefault: boolean;
}> = {
  transfer_liability:  { status: 'liability_transferred', action_path: 'transfer_liability',  driverFacing: true,  chargesByDefault: true },
  pay_direct:          { status: 'driver_notified_pay',   action_path: 'pay_direct',          driverFacing: true,  chargesByDefault: false },
  pay_recharge:        { status: 'paid_recharged',        action_path: 'pay_recharge',        driverFacing: false, chargesByDefault: true },
  request_driver_id:   { status: 'awaiting_driver_id',    action_path: null,                  driverFacing: false, chargesByDefault: false },
  internal_ooosh:      { status: 'internal_ooosh',        action_path: 'internal_ooosh',      driverFacing: false, chargesByDefault: false },
  internal_freelancer: { status: 'internal_freelancer',   action_path: 'internal_freelancer', driverFacing: false, chargesByDefault: false },
  query:               { status: 'under_query',           action_path: 'query',               driverFacing: false, chargesByDefault: false },
};

const fmtDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB') : '—';
const money = (n: number | string | null | undefined) =>
  n == null ? null : `£${Number(n).toFixed(2)}`;

interface ApplyOptions {
  action: PcnAction;
  send_email: boolean;
  add_charge?: boolean;       // override the default for the action
  email_override?: string | null;
}

interface ActionResult {
  status: string;
  emailed: { sent: boolean; to: string | null; fallback: boolean; error: string | null };
  charge: { attempted: boolean; applied: boolean; message: string | null };
}

/**
 * Add the £35+VAT PCN handling charge to the linked HireHop job. Ports the
 * legacy hirehop-charge.js logic: check status, skip if locked/closed, else add
 * the configured charge item via save_job.php + drop a note. Best-effort.
 */
async function addHandlingCharge(
  hhJobNumber: number,
  chargeItem: string,
  pcn: { reference: string | null; vehicle_reg: string | null; offence_at: string | null }
): Promise<{ applied: boolean; message: string }> {
  try {
    const status = await hhBroker.get<Record<string, unknown>>(
      '/php_functions/job_refresh.php', { job: hhJobNumber }, { priority: 'high' }
    );
    const locked = Number((status as { LOCKED?: unknown }).LOCKED) === 1;
    const st = parseFloat(String((status as { STATUS?: unknown }).STATUS ?? ''));
    const closed = [7, 9, 10, 11].includes(st);
    if (locked) return { applied: false, message: 'HireHop job is locked — charge not added, add manually.' };
    if (closed) return { applied: false, message: `HireHop job is closed (status ${st}) — charge not added, add manually.` };

    const items = { [chargeItem]: 1 };
    const res = await hhBroker.post('/api/save_job.php', {
      job: hhJobNumber,
      items: JSON.stringify(items),
      no_webhook: 1,
    }, { priority: 'high' });

    if ((res as { error?: unknown }).error) {
      return { applied: false, message: `HireHop rejected the charge: ${(res as { error?: unknown }).error}` };
    }

    // Best-effort job note
    try {
      const note = [
        '📋 PCN handling charge added (£35+VAT)',
        pcn.vehicle_reg ? `Vehicle: ${pcn.vehicle_reg}` : '',
        pcn.reference ? `PCN ref: ${pcn.reference}` : '',
        pcn.offence_at ? `Offence: ${fmtDate(pcn.offence_at)}` : '',
      ].filter(Boolean).join('\n');
      await hhBroker.post('/php_functions/notes_save.php', { main_id: hhJobNumber, type: 1, note }, { priority: 'low' });
    } catch { /* note is non-critical */ }

    return { applied: true, message: 'PCN handling charge (£35+VAT) added to the HireHop job.' };
  } catch (err) {
    return { applied: false, message: `HireHop charge failed: ${(err as Error).message}` };
  }
}

export async function applyPcnAction(
  pcnId: string,
  opts: ApplyOptions,
  userId: string
): Promise<ActionResult> {
  const r = await query(
    `SELECT p.*, d.full_name AS driver_name, d.email AS driver_email
     FROM pcns p LEFT JOIN drivers d ON d.id = p.driver_id
     WHERE p.id = $1 AND p.is_deleted = false`,
    [pcnId]
  );
  if (r.rows.length === 0) throw new Error('PCN not found');
  const pcn = r.rows[0];

  const map = ACTION_MAP[opts.action];
  const addCharge = (opts.add_charge ?? map.chargesByDefault) === true;

  const settings = await getSystemSettings(['pcn_handling_charge', 'pcn_hh_charge_item']);
  const handlingFee = money(parseFloat(settings.pcn_handling_charge || '35')) || '£35';
  const chargeItem = settings.pcn_hh_charge_item || 'b1744';

  const result: ActionResult = {
    status: map.status,
    emailed: { sent: false, to: null, fallback: false, error: null },
    charge: { attempted: false, applied: false, message: null },
  };

  // ── 1. HireHop handling charge (transfer / recharge, when not waived) ──
  if (addCharge && (opts.action === 'transfer_liability' || opts.action === 'pay_recharge')) {
    result.charge.attempted = true;
    if (!pcn.hh_job_number) {
      result.charge.message = 'No HireHop job linked — charge not added.';
    } else {
      const c = await addHandlingCharge(Number(pcn.hh_job_number), chargeItem, pcn);
      result.charge.applied = c.applied;
      result.charge.message = c.message;
      if (c.applied) {
        await query(
          `UPDATE pcns SET handling_charge_applied = true, handling_amount = $2, hh_charge_pushed_at = NOW() WHERE id = $1`,
          [pcnId, parseFloat(settings.pcn_handling_charge || '35')]
        );
      }
    }
  }

  // ── 2. Client / driver email ──
  const templateByAction: Record<string, string | null> = {
    transfer_liability: 'pcn_transfer_liability',
    pay_direct: 'pcn_pay_direct',
    pay_recharge: 'pcn_pay_recharge',
    request_driver_id: pcn.fine_type === 'police_nip' ? 'pcn_police_nip_urgent' : 'pcn_request_driver_id',
    internal_ooosh: null,
    internal_freelancer: null,
    query: null,
  };
  const templateId = templateByAction[opts.action];

  if (opts.send_email && templateId) {
    try {
      // Resolve recipient
      let to: string | null = opts.email_override?.trim() || null;
      let recipientName = pcn.driver_name || 'Sir/Madam';
      let cc: string[] = [];
      let fallback = false;
      let clientName: string | null = pcn.client_organisation_name || null;

      if (!to && map.driverFacing && pcn.driver_email) {
        to = pcn.driver_email;
        recipientName = pcn.driver_name || recipientName;
      }
      if (!to && pcn.job_id) {
        const tgt = await resolveClientEmailTarget(pcn.job_id, templateId);
        to = tgt.primaryEmail;
        cc = tgt.ccEmails || [];
        fallback = tgt.isFallback;
        clientName = tgt.clientName || clientName;
        if (!map.driverFacing) recipientName = tgt.primaryFirstName || recipientName;
      }
      if (!to) { to = OOOSH_EMAIL; fallback = true; }

      // Notice attachment (best-effort)
      const attachments = [];
      if (pcn.pcn_document_url) {
        try {
          const obj = await getFromR2(pcn.pcn_document_url);
          const bytes = await (obj.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
          const isPdf = pcn.pcn_document_url.toLowerCase().endsWith('.pdf');
          attachments.push({
            filename: `PCN-${pcn.vehicle_reg || 'notice'}-${pcn.reference || ''}.${isPdf ? 'pdf' : 'jpg'}`.replace(/\s/g, ''),
            content: Buffer.from(bytes),
            contentType: isPdf ? 'application/pdf' : 'image/jpeg',
          });
        } catch { /* attachment best-effort */ }
      }

      const reduced = money(pcn.reduced_amount);
      const fineLine = money(pcn.fine_amount)
        ? `${money(pcn.fine_amount)}${reduced ? ` (${reduced} if paid by ${fmtDate(pcn.reduced_deadline)})` : ''}`
        : '—';
      const handlingSentence =
        opts.action === 'pay_recharge'
          ? (addCharge ? `We've added the fine plus an administration fee of ${handlingFee}+VAT to your account.` : `We've added the fine to your account.`)
          : (addCharge ? `As per our hire terms, an administration fee of ${handlingFee}+VAT applies for processing this notice.` : '');
      const jobRef = pcn.hh_job_number ? `#${pcn.hh_job_number}` : '';
      const jobRefSentence = pcn.hh_job_number ? ` (our ref #${pcn.hh_job_number})` : '';

      await emailService.send(templateId, {
        to,
        cc: cc.length ? cc : undefined,
        attachments: attachments.length ? attachments : undefined,
        variables: {
          driverName: pcn.driver_name || 'Sir/Madam',
          clientName: clientName || 'Sir/Madam',
          vehicleReg: pcn.vehicle_reg || '—',
          pcnReference: pcn.reference || '—',
          issuer: pcn.issuing_authority || '—',
          offenceDateTime: `${fmtDate(pcn.offence_at)}${pcn.offence_time_text ? ` ${pcn.offence_time_text}` : ''}`,
          offenceDate: fmtDate(pcn.offence_at),
          location: pcn.location || '—',
          fineLine,
          finalDeadline: fmtDate(pcn.final_deadline),
          handlingFee,
          handlingSentence,
          driverListSentence: '',
          jobRef,
          jobRefSentence,
          oooshEmail: OOOSH_EMAIL,
          oooshPhone: OOOSH_PHONE,
        },
      });
      result.emailed = { sent: true, to, fallback, error: null };
    } catch (err) {
      result.emailed = { sent: false, to: null, fallback: false, error: (err as Error).message };
    }
  }

  // ── 3. Status + action_path + pay-direct deadline ──
  const payDirectDeadline = opts.action === 'pay_direct' ? `NOW() + INTERVAL '48 hours'` : null;
  await query(
    `UPDATE pcns SET status = $2, action_path = $3,
       ${payDirectDeadline ? `pay_direct_deadline = ${payDirectDeadline},` : ''}
       updated_at = NOW()
     WHERE id = $1`,
    [pcnId, map.status, map.action_path]
  );

  // ── 4. Event timeline ──
  const bits: string[] = [`Action: ${opts.action.replace(/_/g, ' ')}`];
  if (result.emailed.sent) bits.push(`emailed ${result.emailed.to}${result.emailed.fallback ? ' (fallback)' : ''}`);
  if (result.charge.applied) bits.push('£35+VAT charge added to HH');
  await query(
    `INSERT INTO pcn_events (pcn_id, event_type, body, metadata, created_by)
     VALUES ($1, 'status_change', $2, $3, $4)`,
    [pcnId, bits.join(' · '), JSON.stringify({ action: opts.action, ...result }), userId]
  );

  return result;
}
