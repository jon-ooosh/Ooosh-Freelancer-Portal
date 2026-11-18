// The referral scheme's pure rules (docs/BUSINESS-FIGURES-SPEC.md §8d).
import {
  bookedRewardLine, codeFromLinkCode, enquiryThanksRewardLine, makeReferralCode, referralForwardUrl, referralStage,
  referralUrl, referralUrlText, reviewReferralLine,
} from '../referral-rules';

describe('makeReferralCode', () => {
  it('is the first name plus four unambiguous characters', () => {
    const seq = [0, 1, 2, 3];
    let i = 0;
    expect(makeReferralCode('Sam', () => seq[i++])).toBe('sam-abcd');
  });
  it('copes with accents, spaces and no name at all', () => {
    expect(makeReferralCode('Zoë-Anne', () => 0)).toBe('zoeanne-aaaa');
    expect(makeReferralCode(null, () => 0)).toBe('friend-aaaa');
    expect(makeReferralCode('   ', () => 0)).toBe('friend-aaaa');
  });
  it('never uses 0, o, 1, l or i in the random part', () => {
    for (let n = 0; n < 200; n++) expect(makeReferralCode('x').split('-')[1]).toMatch(/^[a-hjkmnp-z2-9]{4}$/);
  });
});

describe('links', () => {
  it('lives under go.oooshtours.co.uk/r/', () => {
    expect(referralUrl('sam-7k2p')).toBe('https://go.oooshtours.co.uk/r/sam-7k2p');
    expect(referralUrlText('sam-7k2p')).toBe('go.oooshtours.co.uk/r/sam-7k2p');
  });
  it('forwards to the website tagged so the enquiry form hands the code back', () => {
    const u = new URL(referralForwardUrl('sam-7k2p'));
    expect(u.hostname).toBe('www.oooshtours.co.uk');
    expect(u.pathname).toBe('/contact');   // straight onto the enquiry form (jon, 17 Nov 2026)
    expect(u.searchParams.get('ol')).toBe('ref-sam-7k2p');
    expect(u.searchParams.get('utm_source')).toBe('referral');
  });
  it('reads the code back only from a ref- link code', () => {
    expect(codeFromLinkCode('ref-sam-7k2p')).toBe('sam-7k2p');
    expect(codeFromLinkCode('brighton-source-dec')).toBeNull();
    expect(codeFromLinkCode('ref-')).toBeNull();
    expect(codeFromLinkCode(null)).toBeNull();
  });
});

describe('wording', () => {
  it('the review email line carries both offers, with plain dashes', () => {
    const l = reviewReferralLine({ referrerReward: 'a Tour Store voucher', friendOffer: '£20 off their first hire' });
    expect(l.before).toBe('Know a band who needs vans, backline or rehearsal space? Send them your unique link - ');
    expect(l.after).toBe(" - and they'll get £20 off their first hire. If they book, we'll send ");
    expect(l.tail).toBe(' a Tour Store voucher too, to say thanks.');
    expect(l.before + l.after + l.tail).not.toMatch(/—/);
  });
  it('reads naturally with no offer set', () => {
    const l = reviewReferralLine({ referrerReward: null, friendOffer: '  ' });
    expect(l.after + 'you' + l.tail).toBe(". If they book, we'll send you a thank-you.");
    expect(enquiryThanksRewardLine({ referrerReward: null, friendOffer: null })).toBe("If they end up booking, we'll send you a thank-you.");
    expect(bookedRewardLine({ referrerReward: 'a hoodie', friendOffer: null })).toBe("Once their hire is done, we'll send you a hoodie as promised.");
    expect(bookedRewardLine({ referrerReward: '', friendOffer: null })).toBe("Once their hire is done, we'll send you a thank-you as promised.");
    expect(enquiryThanksRewardLine({ referrerReward: 'a hoodie', friendOffer: null })).toBe("If they end up booking, we'll send you a hoodie as a thank-you.");
  });
});

describe('referralStage', () => {
  it('reads an open referral off the job, never stored', () => {
    expect(referralStage('open', 'new_enquiry')).toBe('Enquired');
    expect(referralStage('open', 'confirmed')).toBe('Booked');
    expect(referralStage('open', 'lost')).toBe("Didn't book");
    expect(referralStage('reward_due', 'completed')).toBe('Thank-you due');
    expect(referralStage('rewarded', 'completed')).toBe('Thanked');
    expect(referralStage('declined', 'confirmed')).toBe('Declined');
  });
});
