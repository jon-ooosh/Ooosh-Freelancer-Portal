/**
 * The referral scheme (docs/BUSINESS-FIGURES-SPEC.md §8d).
 *
 * A PERSON recommends us (never a band). Their friend's enquiry becomes a referral:
 *   - automatically, when the friend came through the person's own link
 *     (go.oooshtours.co.uk/r/<code> → the website with ol=ref-<code> → the enquiry form);
 *   - by staff, from "Referred by" on the job (a name they mentioned, or a postcard).
 * Only a genuinely NEW client counts, never the referrer's own band, and only once per
 * new client (no stacking). When the friend's hire is Completed a To Do asks the admins to
 * send the thank-you — nothing is ever sent or given automatically. The friend's welcome
 * credit is a goodwill credit (source 'referral') reserved on their job: one system for
 * "money off", not two.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { returningClientSql } from './returning-client';
import { offerGoodwill, ownerChoicesForJob, reserveGoodwill, GoodwillError } from './goodwill-credits';
import { createTask, listTasksForSource, updateTask } from './staff-tasks';
import { ukToday } from './uk-date';
import { FALLBACK_URL, deviceOf } from './marketing-links';
// Jon's emails share one sender and one reply-to address (the review email defines them).
import { FROM_NAME, REPLY_TO } from './review-requests';
import {
  BOOKED_STATUSES, OfferText, bookedRewardLine, codeFromLinkCode, enquiryThanksRewardLine, makeReferralCode,
  referralForwardUrl, referralStage, referralUrl, referralUrlText,
} from './referral-rules';

export const REFERRAL_EMAILS_SETTING = 'referral_emails_enabled';
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export class ReferralError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// ── Personal links ──────────────────────────────────────────────────────────

export interface ReferralLink { personId: string; code: string; url: string; urlText: string; scans: number }

function toLink(row: { person_id: string; code: string; scans: number }): ReferralLink {
  return { personId: row.person_id, code: row.code, url: referralUrl(row.code), urlText: referralUrlText(row.code), scans: Number(row.scans) || 0 };
}

export async function getReferralLink(personId: string): Promise<ReferralLink | null> {
  const r = await query(`SELECT person_id, code, scans FROM referral_links WHERE person_id = $1`, [personId]);
  return r.rows[0] ? toLink(r.rows[0]) : null;
}

/** The person's link, made the first time it's needed. The code never changes after. */
export async function getOrCreateReferralLink(personId: string, userId: string | null): Promise<ReferralLink> {
  const existing = await getReferralLink(personId);
  if (existing) return existing;
  const p = await query(`SELECT first_name, preferred_name FROM people WHERE id = $1 AND COALESCE(is_deleted, false) = false`, [personId]);
  if (!p.rows.length) throw new ReferralError('Person not found', 404);
  const first = (p.rows[0].preferred_name || p.rows[0].first_name) as string | null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await query(
      `INSERT INTO referral_links (person_id, code, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING person_id, code, scans`,
      [personId, makeReferralCode(first), userId],
    );
    if (r.rows.length) return toLink(r.rows[0]);
    const again = await getReferralLink(personId); // made at the same moment by someone else
    if (again) return again;
  }
  throw new ReferralError('Could not make a referral link — please try again', 500);
}

/** A scan of /r/<code>: count it (not previews / crawlers) and say where to send them. */
export async function resolveReferralScan(code: string, userAgent: string | undefined): Promise<string> {
  const r = await query(`SELECT code FROM referral_links WHERE code = $1`, [code.toLowerCase()]);
  if (!r.rows.length) return FALLBACK_URL;
  if (deviceOf(userAgent) !== 'bot') {
    await query(`UPDATE referral_links SET scans = scans + 1, last_scan_at = NOW() WHERE code = $1`, [r.rows[0].code])
      .catch((err) => console.error('[referrals] scan not counted (non-fatal):', err));
  }
  return referralForwardUrl(r.rows[0].code);
}

// ── The offer ────────────────────────────────────────────────────────────────

export interface ReferralOffer extends OfferText { id: string | null; friendCreditExVat: number | null; since: string | null }

export async function currentOffer(): Promise<ReferralOffer> {
  const r = await query(
    `SELECT id, referrer_reward, friend_offer, friend_credit_ex_vat::float AS credit, created_at
       FROM referral_offers ORDER BY created_at DESC LIMIT 1`,
  );
  const o = r.rows[0];
  return o
    ? { id: o.id, referrerReward: o.referrer_reward || null, friendOffer: o.friend_offer || null,
        friendCreditExVat: o.credit ?? null, since: new Date(o.created_at).toISOString() }
    : { id: null, referrerReward: null, friendOffer: null, friendCreditExVat: null, since: null };
}

/** A new offer row — the old ones stay, so each referral remembers what was on offer. */
export async function setOffer(input: { referrerReward: string | null; friendOffer: string | null; friendCreditExVat: number | null }, userId: string): Promise<ReferralOffer> {
  await query(
    `INSERT INTO referral_offers (referrer_reward, friend_offer, friend_credit_ex_vat, created_by) VALUES ($1, $2, $3, $4)`,
    [input.referrerReward?.trim() || null, input.friendOffer?.trim() || null, input.friendCreditExVat ?? null, userId],
  );
  return currentOffer();
}

// ── Making a referral ───────────────────────────────────────────────────────

/**
 * Why this person can't be credited with this job, or null if they can. One rule for
 * the automatic link path and staff's "Referred by".
 */
export async function referralBlockReason(jobId: string, referrerPersonId: string): Promise<string | null> {
  const r = await query(
    `SELECT j.id, COALESCE(j.is_internal, false) AS internal,
            ${returningClientSql('j', 'LEAST(j.created_at, COALESCE(j.created_date, j.created_at))')} AS returning,
            EXISTS (SELECT 1 FROM job_contacts jc WHERE jc.job_id = j.id AND jc.person_id = $2) AS self_contact,
            (j.client_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM person_organisation_roles por
                WHERE por.organisation_id = j.client_id AND por.person_id = $2)) AS self_org,
            EXISTS (
              SELECT 1 FROM referrals rf JOIN jobs rj ON rj.id = rf.job_id
               WHERE rf.job_id <> j.id AND rf.status <> 'declined'
                 AND ((j.client_id IS NOT NULL AND rj.client_id = j.client_id)
                   OR EXISTS (SELECT 1 FROM job_contacts a JOIN job_contacts b ON b.person_id = a.person_id
                               WHERE a.job_id = j.id AND b.job_id = rj.id))) AS already
       FROM jobs j WHERE j.id = $1 AND j.is_deleted = false`,
    [jobId, referrerPersonId],
  );
  const j = r.rows[0];
  if (!j) return 'Job not found';
  if (j.internal) return "It's an internal job";
  if (j.self_contact || j.self_org) return "They can't refer their own booking";
  if (j.returning) return "This client has booked with us before, so it isn't a new referral";
  if (j.already) return 'This client has already been referred once (they can only be referred once)';
  return null;
}

export interface CreateReferralInput { jobId: string; referrerPersonId: string; how: 'link' | 'named' | 'card' }

/** Record a referral. Throws ReferralError with a plain reason when it doesn't count. */
export async function createReferral(input: CreateReferralInput, userId: string | null): Promise<string> {
  const exists = await query(`SELECT id FROM referrals WHERE job_id = $1`, [input.jobId]);
  if (exists.rows.length) throw new ReferralError('This job already has a referral — remove it first to change who referred them');
  const block = await referralBlockReason(input.jobId, input.referrerPersonId);
  if (block) throw new ReferralError(block);
  const offer = await currentOffer();
  const ins = await query(
    `INSERT INTO referrals (referrer_person_id, job_id, how, offer_id, created_by)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING RETURNING id`,
    [input.referrerPersonId, input.jobId, input.how, offer.id, userId],
  );
  if (!ins.rows.length) throw new ReferralError('This job already has a referral');
  const id = ins.rows[0].id as string;
  const who = await personName(input.referrerPersonId);
  const how = input.how === 'link' ? 'their personal link' : input.how === 'card' ? 'a referral card' : 'they named them';
  await note(input.jobId, null, `🤝 Referred by ${who} (${how}).`, userId);
  await note(null, input.referrerPersonId, `🤝 Recommended us — job ${await jobLabel(input.jobId)}.`, userId);
  await sendEnquiryThanks(id).catch((err) => console.error('[referrals] thank-you email failed (non-fatal):', err));
  return id;
}

/**
 * The website-intake path: the friend arrived through a personal link. Never throws —
 * a referral that doesn't count is just not recorded (the enquiry is what matters).
 */
export async function referralFromLinkCode(jobId: string, linkCode: string | null | undefined): Promise<void> {
  try {
    const code = codeFromLinkCode(linkCode);
    if (!code) return;
    const l = await query(`SELECT person_id FROM referral_links WHERE code = $1`, [code]);
    if (!l.rows.length) return;
    await createReferral({ jobId, referrerPersonId: l.rows[0].person_id, how: 'link' }, null);
  } catch (err) {
    if (err instanceof ReferralError) {
      console.log(`[referrals] link ${linkCode} on job ${jobId} not counted: ${err.message}`);
      return;
    }
    console.error('[referrals] link referral failed (non-fatal):', err);
  }
}

/** The website enquiry's own tags: a personal link on the visit they enquired on, else the first visit. Never throws. */
export async function referralFromMarketingSource(jobId: string): Promise<void> {
  try {
    const r = await query(
      `SELECT last_touch->>'link_code' AS last_code, link_code FROM job_marketing_source WHERE job_id = $1`,
      [jobId],
    );
    const row = r.rows[0];
    if (!row) return;
    const code = [row.last_code, row.link_code].find((c) => codeFromLinkCode(c));
    if (code) await referralFromLinkCode(jobId, code);
  } catch (err) {
    console.error('[referrals] reading the enquiry tags failed (non-fatal):', err);
  }
}

/** Take a referral off a job (linked by mistake). Only before the thank-you or a welcome credit. */
export async function removeReferral(id: string, userId: string): Promise<void> {
  const r = await query(`SELECT job_id, status, welcome_credit_id FROM referrals WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new ReferralError('Referral not found', 404);
  if (row.status !== 'open' || row.welcome_credit_id) {
    throw new ReferralError('A referral with a thank-you due or given, or a welcome credit, can only be declined (Marketing › Referrals)');
  }
  await query(`DELETE FROM referrals WHERE id = $1`, [id]);
  await note(row.job_id, null, '🤝 Referral removed.', userId);
}

// ── Emails ───────────────────────────────────────────────────────────────────

export async function referralEmailsEnabled(): Promise<boolean> {
  const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [REFERRAL_EMAILS_SETTING]);
  return String(r.rows[0]?.value ?? 'false').trim().toLowerCase() === 'true';
}

export async function setReferralEmailsEnabled(on: boolean, userId: string): Promise<void> {
  await query(
    `INSERT INTO system_settings (key, value, label, category, value_type, sort_order, updated_by, updated_at)
     VALUES ($1, $2, 'Email a referrer when someone they recommended gets in touch (Marketing › Referrals)', 'marketing', 'bool', 61, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [REFERRAL_EMAILS_SETTING, on ? 'true' : 'false', userId],
  );
}

interface Referrer { email: string | null; name: string }

async function referrer(personId: string): Promise<Referrer> {
  const r = await query(`SELECT email, first_name, preferred_name FROM people WHERE id = $1`, [personId]);
  const p = r.rows[0] || {};
  return { email: (p.email as string)?.trim() || null, name: ((p.preferred_name || p.first_name || '') as string).trim() };
}

function greeting(name: string) {
  return { name, hasName: name ? 'yes' : '', noName: name ? '' : 'yes' };
}

/** Email 2 — "someone you recommended has been in touch". Once per referral, only when switched on. Never names the friend. */
export async function sendEnquiryThanks(referralId: string): Promise<boolean> {
  if (!(await referralEmailsEnabled())) return false;
  const r = await query(
    `SELECT rf.referrer_person_id, rf.thanks_email_sent_at, o.referrer_reward, o.friend_offer, j.pipeline_status
       FROM referrals rf JOIN jobs j ON j.id = rf.job_id
       LEFT JOIN referral_offers o ON o.id = rf.offer_id WHERE rf.id = $1`,
    [referralId],
  );
  const row = r.rows[0];
  if (!row || row.thanks_email_sent_at) return false;
  // "Has just been in touch" only reads right for an enquiry. Linked later, once it's already
  // booked, the "they've booked" email (daily) says it instead.
  if (!['new_enquiry', 'quoting', 'paused', 'provisional'].includes(row.pipeline_status)) return false;
  const who = await referrer(row.referrer_person_id);
  if (!who.email) return false;
  // Stamp first, then send — a failure never sends twice.
  const claim = await query(
    `UPDATE referrals SET thanks_email_sent_at = NOW(), updated_at = NOW() WHERE id = $1 AND thanks_email_sent_at IS NULL RETURNING id`,
    [referralId],
  );
  if (!claim.rows.length) return false;
  const result = await emailService.send('referral_enquiry_thanks', {
    to: who.email,
    replyTo: REPLY_TO,
    fromName: FROM_NAME,
    variables: { ...greeting(who.name), rewardLine: enquiryThanksRewardLine({ referrerReward: row.referrer_reward, friendOffer: row.friend_offer }) },
  });
  return result.success;
}

/**
 * Email 2b — "good news, they've booked" (email 2 promises the update). Daily, once per
 * referral, only when the emails are on, only while the friend's job is booked and not yet
 * finished (a completed one gets email 3 instead). Stamp first, then send. Never throws per row.
 */
export async function runReferralBookedEmails(): Promise<number> {
  if (!(await referralEmailsEnabled())) return 0;
  const due = await query(
    `SELECT rf.id, rf.referrer_person_id, o.referrer_reward, o.friend_offer
       FROM referrals rf JOIN jobs j ON j.id = rf.job_id
       LEFT JOIN referral_offers o ON o.id = rf.offer_id
      WHERE rf.status = 'open' AND rf.booked_email_sent_at IS NULL AND j.is_deleted = false
        AND j.pipeline_status = ANY($1::text[])`,
    [[...BOOKED_STATUSES]],
  );
  let n = 0;
  for (const row of due.rows) {
    try {
      const who = await referrer(row.referrer_person_id);
      const claim = await query(
        `UPDATE referrals SET booked_email_sent_at = NOW(), updated_at = NOW() WHERE id = $1 AND booked_email_sent_at IS NULL RETURNING id`,
        [row.id],
      );
      if (!claim.rows.length || !who.email) continue;
      const result = await emailService.send('referral_booked', {
        to: who.email, replyTo: REPLY_TO, fromName: FROM_NAME,
        variables: { ...greeting(who.name), bookedLine: bookedRewardLine({ referrerReward: row.referrer_reward, friendOffer: row.friend_offer }) },
      });
      if (result.success) n++;
    } catch (err) {
      console.error(`[referrals] booked email for ${row.id} failed (non-fatal):`, err);
    }
  }
  return n;
}

/** Email 3 — the thank-you itself, sent by a person from Marketing › Referrals. */
async function sendRewardThanks(referrerPersonId: string, detail: string): Promise<{ ok: boolean; error?: string }> {
  const who = await referrer(referrerPersonId);
  if (!who.email) return { ok: false, error: 'They have no email address' };
  const link = await getOrCreateReferralLink(referrerPersonId, null);
  const result = await emailService.send('referral_reward_thanks', {
    to: who.email,
    replyTo: REPLY_TO,
    fromName: FROM_NAME,
    variables: { ...greeting(who.name), detail: detail.trim().replace(/[.\s]+$/, ''), refLink: link.url, refLinkText: link.urlText },
  });
  return result.success ? { ok: true } : { ok: false, error: result.error };
}

/** "Send me a test" of emails 2 and 3, to the person asking. Writes nothing. */
export async function sendReferralTestEmails(toEmail: string, personId: string | null): Promise<{ ok: boolean; error?: string }> {
  const offer = await currentOffer();
  const name = personId ? (await referrer(personId)).name : '';
  const sample = makeReferralCode(name || 'sam');
  const e2 = await emailService.send('referral_enquiry_thanks', {
    to: toEmail, replyTo: REPLY_TO, fromName: FROM_NAME, subjectOverride: '[Test] Thank you for sending someone our way',
    variables: { ...greeting(name), rewardLine: enquiryThanksRewardLine(offer) },
  });
  const e2b = await emailService.send('referral_booked', {
    to: toEmail, replyTo: REPLY_TO, fromName: FROM_NAME, subjectOverride: "[Test] Good news - they've booked with us",
    variables: { ...greeting(name), bookedLine: bookedRewardLine(offer) },
  });
  const e3 = await emailService.send('referral_reward_thanks', {
    to: toEmail, replyTo: REPLY_TO, fromName: FROM_NAME, subjectOverride: '[Test] A thank-you from Ooosh',
    variables: { ...greeting(name), detail: offer.referrerReward || 'your Tour Store code is ABC123', refLink: referralUrl(sample), refLinkText: referralUrlText(sample) },
  });
  return e2.success && e2b.success && e3.success ? { ok: true } : { ok: false, error: e2.error || e2b.error || e3.error };
}

// ── Thank-you due, given, declined ───────────────────────────────────────────

/** Daily: referrals whose friend's hire is now Completed → "thank-you due" + a To Do for each admin. Never throws per referral. */
export async function runReferralRewardsDue(): Promise<number> {
  const due = await query(
    `SELECT rf.id, rf.referrer_person_id, j.id AS job_id, j.hh_job_number, COALESCE(j.job_name, j.client_name) AS job_name
       FROM referrals rf JOIN jobs j ON j.id = rf.job_id
      WHERE rf.status = 'open' AND j.pipeline_status = 'completed' AND j.is_deleted = false`,
  );
  if (!due.rows.length) return 0;
  const admins = await query(
    `SELECT u.person_id FROM users u
      WHERE u.role = 'admin' AND COALESCE(u.is_active, true) = true AND COALESCE(u.login_disabled, false) = false AND u.person_id IS NOT NULL`,
  );
  let n = 0;
  for (const row of due.rows) {
    try {
      const upd = await query(
        `UPDATE referrals SET status = 'reward_due', reward_due_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'open' RETURNING id`,
        [row.id],
      );
      if (!upd.rows.length) continue;
      const who = await personName(row.referrer_person_id);
      const title = `Referral thank-you due: ${who} sent us ${row.job_name || 'a client'}${row.hh_job_number ? ` (J-${row.hh_job_number})` : ''}`;
      for (const a of admins.rows) {
        await createTask({ title, dueDate: ukToday(), personId: a.person_id, sourceType: 'referral', sourceId: row.id }, SYSTEM_USER_ID, 'admin')
          .catch((err) => console.error('[referrals] To Do not made (non-fatal):', err));
      }
      await note(row.job_id, null, `🤝 The friend's hire is complete — a thank-you is due to ${who}.`, null);
      n++;
    } catch (err) {
      console.error(`[referrals] reward due for ${row.id} failed (non-fatal):`, err);
    }
  }
  return n;
}

async function closeReferralTasks(referralId: string): Promise<void> {
  const open = (await listTasksForSource('referral', referralId) as Array<{ id: string; status: string }>).filter((t) => t.status === 'open');
  for (const t of open) {
    await updateTask(t.id, { status: 'done' }, SYSTEM_USER_ID, 'admin').catch((err) => console.error('[referrals] To Do not closed (non-fatal):', err));
  }
}

/** The thank-you was given. With `sendEmail`, email 3 goes to the referrer first (a failed email stops it). */
export async function markThanked(id: string, input: { detail: string; sendEmail: boolean }, userId: string): Promise<void> {
  const r = await query(`SELECT referrer_person_id, job_id, status FROM referrals WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new ReferralError('Referral not found', 404);
  if (row.status === 'rewarded' || row.status === 'declined') throw new ReferralError(`This referral is already ${row.status === 'rewarded' ? 'thanked' : 'declined'}`);
  if (input.sendEmail) {
    if (!input.detail.trim()) throw new ReferralError('Say what the thank-you is — it goes in the email');
    const sent = await sendRewardThanks(row.referrer_person_id, input.detail);
    if (!sent.ok) throw new ReferralError(`The email didn't send: ${sent.error || 'unknown error'}`, 502);
  }
  await query(
    `UPDATE referrals SET status = 'rewarded', rewarded_at = NOW(), rewarded_by = $2, reward_detail = $3, updated_at = NOW() WHERE id = $1`,
    [id, userId, input.detail.trim() || null],
  );
  await closeReferralTasks(id);
  const who = await personName(row.referrer_person_id);
  await note(row.job_id, row.referrer_person_id, `🤝 Thank-you sent to ${who}${input.detail.trim() ? `: ${input.detail.trim()}` : ''}${input.sendEmail ? ' (emailed)' : ''}.`, userId);
}

export async function declineReferral(id: string, reason: string, userId: string): Promise<void> {
  const r = await query(`SELECT job_id, status FROM referrals WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new ReferralError('Referral not found', 404);
  if (row.status === 'rewarded') throw new ReferralError('The thank-you has already been given');
  await query(
    `UPDATE referrals SET status = 'declined', declined_reason = $2, updated_at = NOW() WHERE id = $1`,
    [id, reason.trim()],
  );
  await closeReferralTasks(id);
  await note(row.job_id, null, `🤝 Referral declined: ${reason.trim()}`, userId);
}

/**
 * The friend's welcome credit: a goodwill credit (source 'referral') for the job's band /
 * client, reserved on this hire. Managers only (the route checks). Once per referral.
 */
export async function giveWelcomeCredit(id: string, input: { amountExVat?: number | null }, userId: string): Promise<string> {
  const r = await query(
    `SELECT rf.job_id, rf.referrer_person_id, rf.welcome_credit_id, rf.status, o.friend_credit_ex_vat::float AS credit
       FROM referrals rf LEFT JOIN referral_offers o ON o.id = rf.offer_id WHERE rf.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new ReferralError('Referral not found', 404);
  if (row.welcome_credit_id) throw new ReferralError('The welcome credit has already been given');
  if (row.status === 'declined') throw new ReferralError('This referral was declined');
  const amount = input.amountExVat ?? row.credit ?? (await currentOffer()).friendCreditExVat;
  if (!amount || amount <= 0) throw new ReferralError('Set the welcome credit amount first (Marketing › Referrals › the offer)');
  const owners = await ownerChoicesForJob(row.job_id);
  const owner = owners[0];
  if (!owner) throw new ReferralError('The job has no client or band to hold the credit');
  const who = await personName(row.referrer_person_id);
  let creditId: string;
  try {
    const g = await offerGoodwill({
      organisation_id: owner.kind === 'organisation' ? owner.id : null,
      person_id: owner.kind === 'person' ? owner.id : null,
      amount_ex_vat: amount,
      reason: `Referral welcome — recommended by ${who}`,
      source_kind: 'referral',
      source_job_id: row.job_id,
    }, userId);
    creditId = g.id;
  } catch (err) {
    if (err instanceof GoodwillError) throw new ReferralError(err.message, err.status);
    throw err;
  }
  await query(`UPDATE referrals SET welcome_credit_id = $2, updated_at = NOW() WHERE id = $1`, [id, creditId]);
  // Held for this hire straight away, so whoever quotes sees it. If it can't be reserved,
  // it stays "to use" on the client — still visible in Client History.
  await reserveGoodwill(creditId, { job_id: row.job_id, reserved_for: 'hire', amount_ex_vat: amount }, userId)
    .catch((err) => console.warn('[referrals] welcome credit not reserved (left to use):', err instanceof Error ? err.message : err));
  return creditId;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface ReferralRow {
  id: string;
  referrerPersonId: string;
  referrerName: string;
  referrerHasEmail: boolean;
  jobId: string;
  jobNumber: number | null;
  jobName: string | null;
  how: string;
  status: string;
  stage: string;
  createdAt: string;
  offer: OfferText & { friendCreditExVat: number | null };
  thanksEmailSentAt: string | null;
  rewardDetail: string | null;
  declinedReason: string | null;
  welcomeCreditRef: string | null;
  welcomeCreditStatus: string | null;
}

const LIST_SQL = `
  SELECT rf.*, j.hh_job_number, COALESCE(j.job_name, j.client_name) AS job_name, j.pipeline_status,
         TRIM(CONCAT_WS(' ', COALESCE(NULLIF(p.preferred_name, ''), p.first_name), p.last_name)) AS referrer_name,
         (COALESCE(TRIM(p.email), '') <> '') AS referrer_has_email,
         o.referrer_reward, o.friend_offer, o.friend_credit_ex_vat::float AS friend_credit,
         g.ref AS credit_ref, g.status AS credit_status
    FROM referrals rf
    JOIN jobs j ON j.id = rf.job_id
    JOIN people p ON p.id = rf.referrer_person_id
    LEFT JOIN referral_offers o ON o.id = rf.offer_id
    LEFT JOIN goodwill_credits g ON g.id = rf.welcome_credit_id`;

function toRow(x: Record<string, unknown>): ReferralRow {
  return {
    id: String(x.id), referrerPersonId: String(x.referrer_person_id), referrerName: String(x.referrer_name || 'Someone'),
    referrerHasEmail: !!x.referrer_has_email,
    jobId: String(x.job_id), jobNumber: (x.hh_job_number as number) ?? null, jobName: (x.job_name as string) || null,
    how: String(x.how), status: String(x.status), stage: referralStage(String(x.status), (x.pipeline_status as string) || null),
    createdAt: new Date(x.created_at as string).toISOString(),
    offer: { referrerReward: (x.referrer_reward as string) || null, friendOffer: (x.friend_offer as string) || null, friendCreditExVat: (x.friend_credit as number) ?? null },
    thanksEmailSentAt: x.thanks_email_sent_at ? new Date(x.thanks_email_sent_at as string).toISOString() : null,
    rewardDetail: (x.reward_detail as string) || null, declinedReason: (x.declined_reason as string) || null,
    welcomeCreditRef: (x.credit_ref as string) || null, welcomeCreditStatus: (x.credit_status as string) || null,
  };
}

export async function listReferrals(): Promise<ReferralRow[]> {
  const r = await query(`${LIST_SQL} ORDER BY CASE rf.status WHEN 'reward_due' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, rf.created_at DESC LIMIT 300`);
  return r.rows.map(toRow);
}

export async function getJobReferral(jobId: string): Promise<ReferralRow | null> {
  const r = await query(`${LIST_SQL} WHERE rf.job_id = $1`, [jobId]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** The person page: their link (if made), how many they've referred, how many thanked. */
export async function personReferralSummary(personId: string): Promise<{ link: ReferralLink | null; referred: number; thanked: number }> {
  const [link, counts] = await Promise.all([
    getReferralLink(personId),
    query(`SELECT COUNT(*) FILTER (WHERE status <> 'declined')::int AS referred, COUNT(*) FILTER (WHERE status = 'rewarded')::int AS thanked
             FROM referrals WHERE referrer_person_id = $1`, [personId]),
  ]);
  return { link, referred: Number(counts.rows[0]?.referred) || 0, thanked: Number(counts.rows[0]?.thanked) || 0 };
}

export async function referralTotals(): Promise<{ links: number; scans: number; referrals: number; booked: number; due: number }> {
  const r = await query(
    `SELECT (SELECT COUNT(*)::int FROM referral_links) AS links,
            (SELECT COALESCE(SUM(scans), 0)::int FROM referral_links) AS scans,
            (SELECT COUNT(*)::int FROM referrals WHERE status <> 'declined') AS referrals,
            (SELECT COUNT(*)::int FROM referrals rf JOIN jobs j ON j.id = rf.job_id
              WHERE rf.status <> 'declined' AND j.pipeline_status NOT IN ('new_enquiry','quoting','paused','provisional','lost','cancelled')) AS booked,
            (SELECT COUNT(*)::int FROM referrals WHERE status = 'reward_due') AS due`,
  );
  const x = r.rows[0] || {};
  return { links: x.links || 0, scans: x.scans || 0, referrals: x.referrals || 0, booked: x.booked || 0, due: x.due || 0 };
}

// ── Small helpers ───────────────────────────────────────────────────────────

async function personName(personId: string): Promise<string> {
  const r = await query(
    `SELECT TRIM(CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name)) AS n FROM people WHERE id = $1`,
    [personId],
  );
  return (r.rows[0]?.n as string) || 'Someone';
}

async function jobLabel(jobId: string): Promise<string> {
  const r = await query(`SELECT hh_job_number, COALESCE(job_name, client_name) AS name FROM jobs WHERE id = $1`, [jobId]);
  const j = r.rows[0];
  if (!j) return '';
  return [j.hh_job_number ? `J-${j.hh_job_number}` : null, j.name].filter(Boolean).join(' · ');
}

/** A timeline line on the job and / or the person. Never throws. */
async function note(jobId: string | null, personId: string | null, text: string, userId: string | null): Promise<void> {
  try {
    if (jobId) {
      await query(`INSERT INTO interactions (job_id, type, content, created_by, source) VALUES ($1, 'note', $2, $3, 'system')`, [jobId, text, userId]);
    }
    if (personId) {
      await query(`INSERT INTO interactions (person_id, type, content, created_by, source) VALUES ($1, 'note', $2, $3, 'system')`, [personId, text, userId]);
    }
  } catch (err) {
    console.warn('[referrals] timeline note failed:', err);
  }
}
