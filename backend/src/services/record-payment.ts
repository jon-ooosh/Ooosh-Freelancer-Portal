/**
 * Record a hire / excess payment on a job — THE path for money arriving by any channel
 * that OP records itself (staff "Record Payment", and the Wise incoming-payment matcher).
 *
 * Lifted verbatim out of `POST /money/:jobId/record-payment` (Oct 2026) so the Wise
 * email matcher could record a bank transfer through exactly the code a staff click
 * runs — OP row, HireHop deposit on the right bank, excess record update, Booked status
 * push, client email, confirmation hooks — rather than a second copy that would drift.
 * The route is now a thin wrapper: validation stays there, everything else is here.
 *
 * Returns `{ status, body }` in the shape the route used to send, so the HTTP contract
 * is unchanged. Callers outside the route read `body.data` / `body.hh_push_error`.
 */
import { query } from '../config/database';
import { hhBroker } from './hirehop-broker';
import { pushDepositToHH, PAYMENT_METHODS_LABELS } from './hh-deposit';
import { sendPaymentEmail, sendExcessEmail, sendLastMinuteAlert } from './money-emails';
import {
  triggerHireFormEmailOnConfirmation as triggerHireFormEmailOnConfirmationShared,
  triggerCarnetFormOnConfirmation,
  hireFormResultIsAnomaly,
  sendConfirmationSilentSkipAlert,
} from './confirmation-hooks';
import { fireEventTriggeredReminders } from './requirement-close-sweep';
import { syncExcessRequirementStatus } from './excess-requirement-sync';

export type RecordPaymentType = 'deposit' | 'balance' | 'excess' | 'refund' | 'excess_refund' | 'other';
export type RecordPaymentMethod =
  | 'stripe_gbp' | 'worldpay' | 'amex' | 'wise_bacs' | 'till_cash' | 'paypal' | 'lloyds_bank' | 'rolled_over';

export interface RecordPaymentInput {
  payment_type: RecordPaymentType;
  amount?: number;
  total_collected?: number;
  payment_method: RecordPaymentMethod;
  payment_reference?: string;
  notes?: string;
  excess_id?: string;
  push_to_hirehop: boolean;
}

export interface RecordPaymentActor {
  /** users.id written to job_payments.recorded_by (the system service user for automation). */
  userId: string;
  /** API-key / automation callers: their id is not a users row for notification FKs. */
  isServiceAccount: boolean;
}

export interface RecordPaymentResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** The system service user (migration 031) — recorded_by for automated recordings. */
export const SYSTEM_SERVICE_USER_ID = '00000000-0000-0000-0000-000000000000';

export async function recordPayment(
  jobId: string,
  input: RecordPaymentInput,
  actor: RecordPaymentActor,
): Promise<RecordPaymentResult> {
  try {
    const { payment_type, payment_method, payment_reference, notes, push_to_hirehop } = input;
    let { amount, excess_id, total_collected } = input;

    // Look up the job
    const jobResult = await query(
      `SELECT id, hh_job_number, client_name, company_name, job_name FROM jobs WHERE id = $1`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return { status: 404, body: { error: 'Job not found' } };
    }

    const job = jobResult.rows[0];

    // Excess auto-find: if no excess_id passed (frontend used to filter out
    // 'taken' records, leaving the field empty when an existing record was
    // present), look up the most recent record on this job. Prefer
    // pre-collection records first, then fall back to any record so top-ups on
    // already-collected excesses link correctly.
    if (payment_type === 'excess' && !excess_id) {
      const found = await query(
        `SELECT id FROM job_excess
         WHERE job_id = $1
         ORDER BY
           CASE WHEN excess_status IN ('needed','pending','partially_paid','partial') THEN 0 ELSE 1 END,
           updated_at DESC
         LIMIT 1`,
        [job.id]
      );
      if (found.rows.length > 0) {
        excess_id = found.rows[0].id;
        console.log(`[money] Auto-linked excess payment to existing record ${excess_id} on job ${job.id}`);
      }
    }

    // total_collected → amount delta translation. Used by the new "Total
    // collected" UX for excess payments.
    if (total_collected !== undefined && excess_id) {
      const existingExcess = await query(
        `SELECT excess_amount_taken FROM job_excess WHERE id = $1`,
        [excess_id]
      );
      if (existingExcess.rows.length > 0) {
        const previousTaken = parseFloat(existingExcess.rows[0].excess_amount_taken || 0);
        amount = total_collected - previousTaken;

        if (Math.abs(amount) < 0.005) {
          return { status: 200, body: {
            data: { idempotent: true, excess_id, message: 'Total collected already matches — nothing to record.' },
            hh_push_error: null,
          } };
        }

        if (amount < 0) {
          return { status: 400, body: {
            error: 'Lowering the total collected requires a refund/correction. Use the excess Manage form instead.',
          } };
        }
      }
    }

    if (amount === undefined || amount < 0.01) {
      return { status: 400, body: { error: 'Amount must be at least £0.01' } };
    }

    // Record in OP
    const paymentResult = await query(
      `INSERT INTO job_payments
        (job_id, hirehop_job_id, payment_type, amount, payment_method,
         payment_reference, payment_status, source, excess_id,
         client_name, recorded_by, notes, payment_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', 'op', $7, $8, $9, $10, NOW())
       RETURNING *`,
      [
        job.id,
        job.hh_job_number,
        payment_type,
        amount,
        payment_method,
        payment_reference || null,
        excess_id || null,
        job.client_name || job.company_name,
        actor.userId,
        notes || null,
      ]
    );

    const payment = paymentResult.rows[0];

    // If this is an excess payment, update the excess record too
    if (payment_type === 'excess' && excess_id) {
      // Card-machine EXCESS payments print a slip that needs scanning for audit
      // — same rule as routes/excess.ts (Worldpay/Amex only; Stripe has an
      // electronic trail, cash/BACS produce no card receipt). Deliberately gated
      // on payment_type === 'excess' by living inside this branch: hire deposits
      // and balances go through the same terminal but are NOT part of the excess
      // receipt trail, so they must never raise this to-do.
      //
      // This route has no receipt-upload step of its own — the flag is what
      // makes the amber banner and the "Upload Receipt Scan" action appear under
      // Manage, which is where staff attach it (with the phone/QR handoff).
      const needsReceipt = payment_method === 'worldpay' || payment_method === 'amex';

      await query(
        `UPDATE job_excess SET
          excess_amount_taken = COALESCE(excess_amount_taken, 0) + $1,
          excess_status = CASE
            WHEN COALESCE(excess_amount_taken, 0) + $1 >= COALESCE(excess_amount_required, 0) THEN 'taken'
            ELSE 'partially_paid'
          END,
          payment_method = $2,
          payment_reference = $3,
          payment_date = NOW(),
          receipt_required = CASE WHEN $5::boolean THEN TRUE ELSE receipt_required END,
          receipt_uploaded_at = CASE WHEN $5::boolean THEN NULL ELSE receipt_uploaded_at END,
          updated_at = NOW()
        WHERE id = $4`,
        [amount, payment_method, payment_reference || null, excess_id, needsReceipt]
      );

      // Promote the excess requirement to 'done' if coverage is now met
      syncExcessRequirementStatus(job.id).catch(e =>
        console.error('[money] syncExcessRequirementStatus failed (record-payment):', e)
      );
    }

    // Status transition: deposit payment on enquiry/provisional → Booked
    // A deposit (or full payment) means the job is confirmed.
    //
    // INVARIANT: `statusChanged` is true ONLY when THIS payment moved the job
    // from a pre-confirmed status into 'confirmed'. Once a job is confirmed,
    // any subsequent payment is just a receipt — it must NOT re-trigger
    // booking-confirmation behaviour (booking_confirmed_deposit email,
    // last-minute alert, hire-form auto-send). Use `statusChanged`, never
    // "is currently confirmed", to gate those side effects.
    let statusChanged = false;
    // The status the job was on when this payment confirmed it — sendLastMinuteAlert()
    // needs it to tell a won booking from a status correction (see migration 226).
    let confirmedFromStatus: string | null = null;
    if ((payment_type === 'deposit' || payment_type === 'balance') && amount > 0) {
      try {
        const statusResult = await query(
          `SELECT pipeline_status, hh_job_number FROM jobs WHERE id = $1`,
          [job.id]
        );
        const currentStatus = statusResult.rows[0]?.pipeline_status;
        const hhNum = statusResult.rows[0]?.hh_job_number;

        if (currentStatus && ['new_enquiry', 'quoting', 'chasing', 'provisional'].includes(currentStatus)) {
          // Move to confirmed in OP
          // confirmed_at is stamped here too. Until now only the pipeline
          // route set it, so every job won by a payment had a NULL
          // confirmed_at — job 16491 among them — which made the field
          // useless for "when did we win this". COALESCE so a job that was
          // already confirmed once keeps its original date.
          await query(
            `UPDATE jobs SET pipeline_status = 'confirmed', pipeline_status_changed_at = NOW(),
                             confirmed_at = COALESCE(confirmed_at, NOW()), updated_at = NOW()
             WHERE id = $1`,
            [job.id]
          );
          statusChanged = true;
          confirmedFromStatus = currentStatus;
          console.log(`[money] Job ${job.id} moved to confirmed (deposit received)`);

          // Push status to HireHop (status 2 = Booked).
          // ⚠️ The broker RESOLVES { success: false } on a rate-limit failure (327/329) — it
          // does NOT throw. Check pushResult.success before mirroring the status locally, or
          // OP declares "Booked" off a failed push and the next 30-min sync reverts it
          // (job 16513 split-brain). On failure, leave jobs.status for the reconciler to retry.
          if (hhNum) {
            try {
              const pushResult = await hhBroker.post('/frames/status_save.php', {
                job: hhNum,
                status: 2, // Booked
                no_webhook: 1,
              }, { priority: 'high' });
              if (pushResult.success) {
                await query(
                  `UPDATE jobs SET status = 2, status_name = 'Booked', hh_status = 2 WHERE id = $1`,
                  [job.id]
                );
                console.log(`[money] HH job ${hhNum} status updated to Booked`);
              } else {
                console.error(
                  `[money] HH status push to Booked FAILED (record-payment, job ${hhNum}): ${pushResult.error} — leaving jobs.status for the reconciler`
                );
              }
            } catch (pushErr) {
              console.error('[money] HH status update to Booked threw (record-payment):', pushErr);
            }
          }
        }
      } catch (err) {
        console.error('[money] Status transition failed (non-fatal):', err);
      }

      // Event-triggered reminders ("notify me if this job confirms"). Gated on
      // `statusChanged`, which is true only when THIS payment won the booking —
      // same invariant the hire form email below uses. Until now only the OP
      // pipeline route fired these, so a job won by a deposit fired none of
      // them. Never throws, and self-marks the reminder done, so another route
      // firing the same trigger is a no-op.
      if (statusChanged) {
        // API-key / automation callers have no users row for the notifications FK,
        // so only a real logged-in staff user is passed as the actor (the route
        // decides `isServiceAccount`; see routes/money.ts).
        const actorId = actor.isServiceAccount ? null : actor.userId;
        await fireEventTriggeredReminders(job.id, 'confirmed', actorId);
      }

      // Hire form email: if job has self-drive vehicle and starts within 10 days, send now.
      // Only fires when this payment actually confirmed the booking — subsequent
      // payments on an already-confirmed job must not re-send the hire form email.
      if (statusChanged) {
        (async () => {
          try {
            const hfResult = await triggerHireFormEmailOnConfirmationShared(job.id);
            triggerCarnetFormOnConfirmation(job.id).catch(() => {});
            const anomaly = hireFormResultIsAnomaly(hfResult);
            if (anomaly) {
              await sendConfirmationSilentSkipAlert({
                jobId: job.id,
                jobNumber: job.hh_job_number,
                jobName: job.job_name ?? null,
                clientName: job.client_name,
                triggerSource: 'status_change',
                issues: [anomaly],
              });
            }
          } catch (err) {
            console.error('[money] Hire form email on confirmation failed (record-payment):', err);
          }
        })();
      }
    }

    // Push to HireHop as deposit (if requested and job has HH number).
    //
    // Failures used to be swallowed silently — the response was 200 OK with
    // hirehop_deposit_id: null and no signal to the user. We now surface the
    // error in the response so the frontend can show a "Saved in OP but HH
    // push failed" banner and prompt for manual link/retry.
    let hhDepositId: number | null = null;
    let xeroSynced = false;
    let hhPushError: string | null = null;
    if (push_to_hirehop && job.hh_job_number && payment_type !== 'refund' && payment_method !== 'rolled_over') {
      const pushResult = await pushDepositToHH({
        hhJobNumber: Number(job.hh_job_number),
        amount,
        paymentMethod: payment_method,
        paymentReference: payment_reference || null,
        paymentType: payment_type,
        notes: notes || null,
      });
      hhDepositId = pushResult.hhDepositId;
      xeroSynced = pushResult.xeroSynced;
      hhPushError = pushResult.error;

      if (hhDepositId) {
        try {
          await query(
            `UPDATE job_payments SET hirehop_deposit_id = $1 WHERE id = $2`,
            [hhDepositId, payment.id]
          );

          // Link HH deposit to job_excess record for reconciliation
          if (payment_type === 'excess' && excess_id) {
            await query(
              `UPDATE job_excess SET hh_deposit_id = $1, hh_reconciled_at = NOW(), hh_reconcile_source = 'op_push' WHERE id = $2 AND hh_deposit_id IS NULL`,
              [hhDepositId, excess_id]
            );
          }
        } catch (linkErr) {
          console.error('[money] HH deposit linkage update failed (non-fatal):', linkErr);
        }
      }
    } else if (push_to_hirehop && !job.hh_job_number) {
      // Caller asked for HH push but the job isn't linked to HireHop yet —
      // surface this so they know the payment is OP-only.
      hhPushError = 'Job is not linked to HireHop yet — payment recorded in OP only. Create the HH job first to enable HH sync.';
    }

    // ── Email triggers (fire-and-forget) ──
    try {
      const bankLabel = PAYMENT_METHODS_LABELS[payment_method] || payment_method;

      if (payment_type === 'excess') {
        // Excess payment email — only if linked to an excess record
        if (excess_id) {
          sendExcessEmail({
            templateId: 'excess_payment_confirmed',
            excessId: excess_id,
            jobId: job.id,
            amount,
            paymentMethod: payment_method,
          }).catch(e => console.error('[money] Excess email failed:', e));
        }
        // Excess payments never trigger booking confirmation or last-minute alerts
      } else {
        // Hire payment email — see invariant comment on `statusChanged` above.
        // `isConfirmingBooking` must reflect "did THIS payment confirm the
        // booking?", not "is the booking currently confirmed?". Subsequent
        // payments on already-confirmed jobs are receipts, not confirmations.
        const payResult = await sendPaymentEmail({
          jobId: job.id,
          amount,
          bankName: bankLabel,
          paymentType: payment_type,
          isConfirmingBooking: statusChanged,
        });
        if (!payResult.sent) {
          console.error(
            `[money] Payment email not sent (record-payment, job ${job.id}): ${payResult.reason}${payResult.error ? ` — ${payResult.error}` : ''}`
          );
          sendConfirmationSilentSkipAlert({
            jobId: job.id,
            jobNumber: job.hh_job_number,
            jobName: job.job_name ?? null,
            clientName: job.client_name,
            triggerSource: 'status_change',
            issues: [{
              kind: 'payment_email',
              reason: payResult.reason === 'no_recipient'
                ? 'no client email found in OP address book (client org has no email and no linked contacts with emails)'
                : 'unexpected error while sending payment confirmation email',
              context: payResult.error,
            }],
          }).catch(e => console.error('[money] Silent-skip alert failed (record-payment):', e));
        }

        // Last-minute alert: only fires when this payment actually confirmed
        // the booking. Receipts on already-confirmed jobs must not re-alert.
        if (statusChanged) {
          sendLastMinuteAlert(job.id, confirmedFromStatus).catch(e => console.error('[money] Last-minute alert failed:', e));
        }
      }
    } catch (emailErr) {
      console.error('[money] Email trigger error (non-fatal):', emailErr);
    }

    return {
      status: 200,
      body: {
        data: {
          ...payment,
          hirehop_deposit_id: hhDepositId,
          xero_synced: xeroSynced,
        },
        hh_push_error: hhPushError,
      },
    };
  } catch (error) {
    console.error('[money] Record payment error:', error);
    return { status: 500, body: { error: 'Failed to record payment' } };
  }
}
