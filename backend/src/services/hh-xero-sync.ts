/**
 * hh-xero-sync.ts — THE way OP asks HireHop to push a billing row to Xero.
 *
 * Every money-out path writes a row with `billing_deposit_save.php` or
 * `billing_payments_save.php` and then has to fire `accounting/tasks.php` to
 * get it into Xero. That second call was copy-pasted into five places, and
 * every copy was blind:
 *
 *     await hhBroker.post('/php_functions/accounting/tasks.php', {...});
 *     console.log('Xero sync triggered');     // ← says this either way
 *
 * `hhBroker.post` RESOLVES `{ success: false, error }` — it never throws — so
 * the surrounding try/catch never fired, the return value was discarded, and
 * the log line was true by construction and informative never.
 *
 * WHAT THAT COST (job 15187, 15 Sep 2026)
 * ---------------------------------------
 * A £120 goodwill credit note was raised on 4 Sep, after the £258.48 balance
 * deposit had already been allocated to the invoice in Xero on 2 Sep. In
 * HireHop the credit note then satisfied part of the invoice, freeing £120 on
 * the deposit — so refunding out of the deposit was correct there, and it
 * worked. In Xero the mirror image was true: the overpayment was spent and the
 * CREDIT NOTE was the document left unfunded. Xero refused the refund:
 *
 *     Can't create payment for invoice
 *     Xero error: Payments can only be made against Authorised documents [2263]
 *
 * (an overpayment flips AUTHORISED → PAID once fully allocated, and Xero won't
 * post a payment against a terminal document). HireHop handed us that message
 * verbatim in the `tasks.php` response body. We threw it away, returned 200,
 * and told staff the refund was recorded. Stripe had moved real money.
 *
 * That shape is NOT fixable from OP — see MONEY-AND-EXCESS.md. Posting the
 * refund against the credit note in HireHop instead would double-count it
 * there (the credit note is already consumed) and leave the deposit reading as
 * still refundable, inviting a second refund. The money is right; only Xero
 * needs a hand-tidy. So the job here is to SAY SO, loudly and durably, not to
 * be clever.
 *
 * WHY THERE IS NO "verify by re-reading" STEP
 * -------------------------------------------
 * The release path learned to distrust save responses (HireHop once returned
 * `success: true` for a write it silently clamped to £0 — see
 * hh-deposit-release.ts). That lesson does NOT extend here: `tasks.php` reports
 * its own failures honestly in the response body. A re-read would spend an
 * extra HireHop call per refund to rediscover what the response already said.
 * If we ever do want to verify, the field is `data.ACC_ID` on the billing row
 * — populated with the Xero object id once a row has landed, empty until then
 * (that is the little cloud icon in the HireHop billing UI, in data form).
 */

import { hhBroker } from './hirehop-broker';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';

export interface XeroSyncResult {
  ok: boolean;
  /** HireHop's own message, tags stripped. Null when ok. */
  error: string | null;
}

/**
 * HireHop returns errors as display HTML (`<b>Can't create payment for invoice
 * </b><br>Xero error: …<br>[2263]`). Flatten it to one readable line for the
 * UI, the notes column and the alert email.
 */
export function cleanHhError(raw: string | null | undefined): string {
  if (!raw) return 'Unknown error';
  return String(raw)
    .replace(/<br\s*\/?>/gi, ' — ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .replace(/\s+—\s+$/, '')
    .trim();
}

/**
 * Push one saved HireHop billing row to Xero.
 *
 * `savedData` is the WHOLE `billing_*_save.php` response body, not just the id:
 * HireHop names its own sync parameters in it (`hh_task`, `hh_id`,
 * `hh_acc_package_id`, `hh_package_type`), so we read them back rather than
 * assuming the hardcoded `post_payment` / `1` / `3` that five callers used to
 * send. Today HireHop always names exactly those values — confirmed on job
 * 15187 — but reading them back costs nothing and covers the day it doesn't.
 */
export async function syncSavedRowToXero(
  label: string,
  savedData: Record<string, any> | undefined | null,
): Promise<XeroSyncResult> {
  const hhId = savedData?.hh_id ?? savedData?.id ?? savedData?.ID ?? null;
  if (!hhId) {
    const error = 'HireHop saved the row but returned no id, so OP could not ask it to sync to Xero.';
    console.error(`[hh-xero] ${label}: ${error}`);
    return { ok: false, error };
  }

  try {
    const res = await hhBroker.post('/php_functions/accounting/tasks.php', {
      hh_package_type: savedData?.hh_package_type ?? 1,
      hh_acc_package_id: savedData?.hh_acc_package_id ?? 3,
      hh_task: savedData?.hh_task ?? 'post_payment',
      hh_id: hhId,
      hh_acc_id: '',
    }, { priority: 'high' });

    if (!res.success) {
      const error = cleanHhError(res.error);
      console.error(`[hh-xero] ${label}: Xero sync REFUSED — ${error}`);
      return { ok: false, error };
    }
    console.log(`[hh-xero] ${label}: Xero sync accepted (hh_id ${hhId})`);
    return { ok: true, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[hh-xero] ${label}: Xero sync threw — ${error}`);
    return { ok: false, error };
  }
}

// ── Alert ─────────────────────────────────────────────────────────────────
//
// Admin-only by design. The remedy is always "fix it in Xero", which only the
// account owner can do, so routing this to info@ would just add noise to an
// inbox full of things other people are meant to action. Same hardcoded
// recipient + rationale as `sendPortalHHPushFailedAlert` in routes/money.ts:
// the volume should be near-zero. Move to `system_settings` if that changes.
const XERO_SYNC_ALERT_RECIPIENT = 'jon@oooshtours.co.uk';

/** Xero's "document is already PAID, you can't post a payment to it" refusal. */
function isAuthorisedDocumentRefusal(error: string): boolean {
  return /\b2263\b/.test(error) || /Authorised documents/i.test(error);
}

export interface XeroSyncAlertContext {
  /** OP job UUID — used for the "view job" link. */
  jobId: string | null;
  hhJobNumber: number | string | null;
  /** What OP was trying to record, e.g. "hire refund", "excess reimbursement". */
  what: string;
  amount: number;
  clientName?: string | null;
  /** HireHop billing row that did not reach Xero. */
  hhRowId?: number | string | null;
  hhDepositId?: number | string | null;
  /** True when real money has already moved (Stripe), so this is paperwork-only. */
  moneyMoved?: boolean;
  error: string;
}

/**
 * Tell the one person who can fix it that a row is in HireHop but not in Xero.
 *
 * Never throws and never awaited for correctness — the money movement it
 * describes has already happened, and a failed email must not turn a recorded
 * refund into a 500.
 */
export async function sendXeroSyncFailedAlert(ctx: XeroSyncAlertContext): Promise<void> {
  try {
    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmtMoney = (n: number) =>
      n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
    const jobUrl = ctx.jobId ? `${getFrontendUrl()}/jobs/${ctx.jobId}` : null;
    const jobLabel = ctx.hhJobNumber ? `#${ctx.hhJobNumber}` : (ctx.jobId || 'unknown job');

    // The 2263 shape has a known, specific remedy — name it rather than making
    // whoever reads this re-derive the HireHop/Xero mirror-image from scratch.
    const remedy = isAuthorisedDocumentRefusal(ctx.error)
      ? `<p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
           <strong>Almost certainly the credit-note shape.</strong> Xero's copy of this deposit is an
           <em>overpayment</em> that has already been fully allocated to the invoice, so Xero marks it
           PAID and refuses any further payment against it — including a refund. In HireHop the mirror
           is true: the credit note is the part that has been consumed and the deposit is the free
           money, which is why the HireHop side is correct and complete.
         </p>
         <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
           <strong>Fix in Xero:</strong> find the client's credit note for ${escape(fmtMoney(ctx.amount))}
           (it will be sitting at <em>Awaiting payment</em>) and record a cash refund against it from the
           bank account the money actually left, dated to match. Nothing to change in HireHop —
           it is already right, the row just won't ever get its cloud icon.
         </p>`
      : `<p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
           <strong>Fix:</strong> open the row in HireHop billing, double-click it and Save — that re-fires
           the Xero push. If it refuses again, the message above is Xero's own and the correction has to
           be made in Xero by hand.
         </p>`;

    const html = `
      <h2 style="margin:0 0 12px;font-size:18px;color:#b91c1c;">HireHop → Xero sync refused</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Job <strong>${escape(jobLabel)}</strong> — a ${escape(ctx.what)} of
        <strong>${fmtMoney(ctx.amount)}</strong> was recorded in HireHop${ctx.moneyMoved ? ' and the money has moved in Stripe' : ''},
        but HireHop could not push it to Xero.
      </p>
      <p style="margin:0 0 12px;padding:10px 12px;background:#fef2f2;border-left:3px solid #b91c1c;font-size:13px;color:#7f1d1d;line-height:1.5;">
        ${escape(ctx.error)}
      </p>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;">
        ${ctx.clientName ? `<strong>Client:</strong> ${escape(ctx.clientName)}<br>` : ''}
        ${ctx.hhRowId ? `<strong>HireHop billing row:</strong> ${escape(String(ctx.hhRowId))}<br>` : ''}
        ${ctx.hhDepositId ? `<strong>HireHop deposit:</strong> ${escape(String(ctx.hhDepositId))}<br>` : ''}
      </p>
      ${remedy}
      <p style="margin:0 0 12px;font-size:13px;color:#64748b;line-height:1.5;">
        OP and HireHop agree; only Xero is short. Nothing needs re-refunding — check before you move
        any money.
      </p>
      ${jobUrl ? `<p style="margin:0;font-size:14px;">
        <a href="${jobUrl}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
      </p>` : ''}
    `;

    await emailService.sendRaw({
      to: XERO_SYNC_ALERT_RECIPIENT,
      subject: `[Xero sync failed] Job ${jobLabel} — ${ctx.what} ${fmtMoney(ctx.amount)} not in Xero`,
      html,
      variant: 'internal',
    });
    console.log(`[hh-xero] Sync-failed alert sent to ${XERO_SYNC_ALERT_RECIPIENT} for job ${jobLabel} (${ctx.what})`);
  } catch (err) {
    console.error('[hh-xero] sendXeroSyncFailedAlert failed (non-fatal):', err);
  }
}
