/**
 * The referral scheme — the pure part (docs/BUSINESS-FIGURES-SPEC.md §8d).
 * Codes, the link a scan is forwarded to, and the wording that depends on the
 * current offer. No database here, so it can be tested on its own.
 */
import { randomInt } from 'crypto';
import { SHORT_LINK_BASE } from './marketing-links';

/** A personal link travels through the website as `ol=ref-<code>` (job_marketing_source.link_code). */
export const REFERRAL_LINK_PREFIX = 'ref-';
/** Where a personal link lands — the website, tagged so the enquiry form hands the code back. */
export const REFERRAL_LANDING = 'https://www.oooshtours.co.uk/';

// No 0/o, 1/l/i — the code may be read off a screen or typed.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 'Sam' → 'sam-7k2p'. The name part is a courtesy; the four characters make it unique. */
export function makeReferralCode(firstName: string | null | undefined, rand: (n: number) => number = randomInt): string {
  const name = (firstName || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'friend';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += ALPHABET[rand(ALPHABET.length)];
  return `${name}-${tail}`;
}

export function referralUrl(code: string): string {
  return `${SHORT_LINK_BASE}r/${code}`;
}

/** What someone sees in an email: the address without https://. */
export function referralUrlText(code: string): string {
  return referralUrl(code).replace(/^https?:\/\//, '');
}

/** The website address a personal-link scan is sent to. */
export function referralForwardUrl(code: string): string {
  const u = new URL(REFERRAL_LANDING);
  u.searchParams.set('utm_source', 'referral');
  u.searchParams.set('utm_medium', 'personal-link');
  u.searchParams.set('utm_campaign', 'referral');
  u.searchParams.set('ol', REFERRAL_LINK_PREFIX + code);
  return u.toString();
}

/** The referral code inside a job's link code, or null. */
export function codeFromLinkCode(linkCode: string | null | undefined): string | null {
  if (!linkCode || !linkCode.startsWith(REFERRAL_LINK_PREFIX)) return null;
  const code = linkCode.slice(REFERRAL_LINK_PREFIX.length).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(code) ? code : null;
}

export interface OfferText { referrerReward: string | null; friendOffer: string | null }

/**
 * The review email's referral line, split round the link so the link can be a real
 * <a>. Jon's wording, 16 Nov 2026 (plain dashes, not long ones).
 */
export function reviewReferralLine(offer: OfferText): { before: string; after: string } {
  const friend = offer.friendOffer?.trim();
  const reward = offer.referrerReward?.trim();
  return {
    before: 'Know a band who needs vans, backline or rehearsal space? Send them your link - ',
    after: (friend ? ` - and they'll get ${friend}.` : '.')
      + (reward ? ` If they book, we'll send you ${reward} to say thanks.` : " If they book, we'll send you a thank-you."),
  };
}

/** Email 2's middle sentence — "we'll send {reward} your way", or a plain thank-you. */
export function enquiryThanksRewardLine(offer: OfferText): string {
  const reward = offer.referrerReward?.trim();
  return reward
    ? `If they end up booking, we'll send ${reward} your way as a thank-you.`
    : "If they end up booking, we'll send a thank-you your way.";
}

/**
 * Where a referral stands, for people. Stored status + the friend's job: an `open`
 * referral reads off the job (enquired / booked / didn't book) — never stored.
 */
export function referralStage(status: string, pipelineStatus: string | null): string {
  if (status === 'rewarded') return 'Thanked';
  if (status === 'declined') return 'Declined';
  if (status === 'reward_due') return 'Thank-you due';
  if (pipelineStatus === 'lost' || pipelineStatus === 'cancelled') return "Didn't book";
  if (pipelineStatus === 'completed') return 'Completed';
  if (['new_enquiry', 'quoting', 'paused', 'provisional'].includes(pipelineStatus || '')) return 'Enquired';
  return 'Booked';
}
