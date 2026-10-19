/**
 * DVA (Northern Ireland) licence check — the "a human has to go and get this" alert.
 *
 * WHY THIS EXISTS
 * ---------------
 * A GB driver runs their own licence check: they generate a share code at
 * viewdrivingrecord.service.gov.uk, upload the summary, and the hire-form app
 * reads it with nobody involved. A Northern Ireland driver cannot. DVA run
 * their own service at nidirect where the driver creates a check code and a
 * THIRD PARTY performs the lookup — so the check only happens if a member of
 * staff goes and does it.
 *
 * Which makes this alert load-bearing rather than a nicety. The driver submits
 * their code and the hire form parks them on "we're checking this by hand" —
 * a terminal state they cannot get out of by themselves. A parked driver whom
 * nobody was told about is the spinning-wheel-of-death pattern with extra
 * steps (ProcessingHub, Jul 2026). The form is only allowed to stop the driver
 * because this fires.
 *
 * Modelled on sendIdentityReviewAlert / sendReferralAlert: one email to the
 * vehicle-notification targets, best-effort, never allowed to roll back the
 * write it is announcing.
 *
 * NOT deduped by a claim column, deliberately — unlike a referral or an
 * identity review, which are one state needing one decision, each NEW code is
 * a new piece of work. A DVA check code is single-use and expires 21 days
 * after the driver created it, so a driver sending a second code means the
 * first is spent or stale and staff need telling again. The caller only fires
 * when the code has actually CHANGED, which is what keeps this from repeating
 * on a page refresh.
 */

import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';
import { getVehicleNotificationTargets } from './vehicle-notify';

export interface DvaCheckAlertResult {
  sent: boolean;
  reason?: 'not_found' | 'send_failed';
}

export async function sendDvaCheckAlert(driverId: string): Promise<DvaCheckAlertResult> {
  try {
    const res = await query(
      `SELECT id, full_name, email, licence_number, dvla_check_code, current_job_number
         FROM drivers WHERE id = $1`,
      [driverId],
    );
    if (res.rows.length === 0) return { sent: false, reason: 'not_found' };
    const d = res.rows[0];

    const targets = await getVehicleNotificationTargets();

    // The bell, for whoever is at a screen. `email_sent_at = NOW()` so the
    // escalation scheduler doesn't fire its own second email on top of the one
    // below — same reason as the referral bell in routes/driver-verification.ts.
    for (const userId of targets.bellUserIds) {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, action_url, priority, email_sent_at)
         VALUES ($1, 'dva_check', $2, $3, $4, 'high', NOW())`,
        [
          userId,
          `NI licence check needed: ${d.full_name || 'driver'}`,
          `${d.full_name || 'A driver'} has a Northern Ireland (DVA) licence and cannot run their own `
            + `licence check. They have supplied check code ${d.dvla_check_code || '(none)'} and are `
            + `waiting on the nidirect lookup`
            + `${d.current_job_number ? ` for job #${d.current_job_number}` : ''}.`,
          `/drivers/${driverId}`,
        ],
      );
    }

    await emailService.send('dva_check_pending', {
      to: targets.to,
      cc: targets.cc,
      variables: {
        driverName: d.full_name || 'Unknown driver',
        driverEmail: d.email || 'N/A',
        jobNumber: d.current_job_number ? String(d.current_job_number) : '',
        checkCode: d.dvla_check_code || 'not supplied',
        licenceNumber: d.licence_number || 'not on record',
        driverUrl: `${getFrontendUrl()}/drivers/${driverId}`,
      },
    });

    console.log(`[dva-check] Alert sent for driver ${d.full_name} (${driverId})`);
    return { sent: true };
  } catch (err) {
    console.error('[dva-check] Failed to send DVA check alert:', err);
    return { sent: false, reason: 'send_failed' };
  }
}
