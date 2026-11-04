import crypto from 'crypto';
import { computeTwilioSignature, isValidTwilioSignature, planDial, sipUser, sayXml } from '../telephony';

describe('Twilio signature', () => {
  const token = 'test-token';
  const url = 'https://staff.oooshtours.co.uk/api/telephony/recording?kind=call';
  const params = { CallSid: 'CA1', RecordingSid: 'RE1', From: '+447700900123' };

  it('is HMAC-SHA1 over the URL then params sorted by name', () => {
    const manual = crypto.createHmac('sha1', token)
      .update(url + 'CallSidCA1From+447700900123RecordingSidRE1').digest('base64');
    expect(computeTwilioSignature(token, url, params)).toBe(manual);
  });

  it('accepts the right signature and refuses a tampered one', () => {
    const sig = computeTwilioSignature(token, url, params);
    expect(isValidTwilioSignature(token, sig, url, params)).toBe(true);
    expect(isValidTwilioSignature(token, sig, url, { ...params, From: '+447700900999' })).toBe(false);
    expect(isValidTwilioSignature(token, sig, url.replace('call', 'voicemail'), params)).toBe(false);
    expect(isValidTwilioSignature(token, undefined, url, params)).toBe(false);
  });
});

describe('dialled numbers', () => {
  it('reads the user part of a SIP URI', () => {
    expect(sipUser('sip:07700900123@ooosh.sip.twilio.com;user=phone')).toBe('07700900123');
    expect(sipUser('sip:base1@ooosh.sip.twilio.com')).toBe('base1');
    expect(sipUser('')).toBe('');
  });

  it('turns UK and international dialling into E.164', () => {
    expect(planDial('07911123456')).toEqual({ kind: 'ok', e164: '+447911123456' });
    expect(planDial('01273911382')).toEqual({ kind: 'ok', e164: '+441273911382' });
    expect(planDial('0033142685300')).toEqual({ kind: 'ok', e164: '+33142685300' });
    expect(planDial('+33142685300')).toEqual({ kind: 'ok', e164: '+33142685300' });
  });

  it('never refuses an emergency number', () => {
    expect(planDial('999')).toEqual({ kind: 'emergency', number: '999' });
    expect(planDial('112')).toEqual({ kind: 'emergency', number: '112' });
  });

  it('refuses premium rate and junk', () => {
    expect(planDial('09098790000')).toEqual({ kind: 'refused', reason: 'premium' });
    expect(planDial('12')).toEqual({ kind: 'refused', reason: 'unparseable' });
    expect(planDial('abc')).toEqual({ kind: 'refused', reason: 'unparseable' });
  });
});

describe('spoken messages', () => {
  const s = { voice: 'Polly.Amy-Neural', sayOooshAs: 'oosh' };
  it('says Ooosh the configured way, escapes the rest', () => {
    expect(sayXml("Thanks for calling Ooosh Tours & co, info at oooshtours", s)).toBe(
      '<Say voice="Polly.Amy-Neural">Thanks for calling <sub alias="oosh">Ooosh</sub> Tours &amp; co, info at <sub alias="oosh">ooosh</sub>tours</Say>',
    );
  });
});
